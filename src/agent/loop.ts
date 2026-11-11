import { config } from '../config';
import { streamCompletion, isAbort } from '../llm/client';
import type { ChatMessage } from '../llm/client';
import { TOOLS, executeSearchTool } from './tools';
import { buildSystemPrompt } from './prompt';
import { retrieveMemory, sinceDaysHint } from '../memory/retrieve';
import { store } from '../memory/store';
import { extractMemory } from '../memory/extract';
import type { Message, Source, TurnDoc } from '../memory/store';
import type { RetrievedMemory } from '../memory/retrieve';
import { logger, errorMessage } from '../util/log';

const log = logger('agent');

export interface AgentEvents {
  onMeta: (meta: { conversationId: string; userMessageId: string }) => void;
  onMemory: (items: RetrievedMemory[]) => void;
  onStatus: (text: string) => void;
  onDelta: (text: string) => void;
  onSources: (sources: Source[]) => void;
}

export interface ChatRequest {
  conversationId?: string;
  userMessage: string;
  timeZone: string;
  signal: AbortSignal;
  events: AgentEvents;
}

export interface ChatResult {
  conversationId: string;
  assistantMessage: Message;
  recalled: RetrievedMemory[];
  sources: Source[];
  aborted: boolean;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'New chat';
  return `${clean.slice(0, 57)}…`;
}

function queryLabelForStatus(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson || '{}') as { query?: unknown };
    return typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : null;
  } catch {
    return null;
  }
}

/**
 * One user message -> one streamed answer.
 *
 * Loop: retrieve memory -> build context -> stream from the model -> execute any
 * web_search calls in parallel -> repeat with tool results -> final answer is
 * persisted and distilled into memory in the background.
 */
export async function runChat(request: ChatRequest): Promise<ChatResult> {
  const { userMessage, timeZone, signal, events } = request;

  const conversation =
    (request.conversationId ? store.getConversation(request.conversationId) : undefined) ??
    store.createConversation('New chat');
  if (conversation.messages.length === 0) store.renameConversation(conversation.id, deriveTitle(userMessage));

  const userMsg = store.addMessage(conversation.id, { role: 'user', content: userMessage });
  events.onMeta({ conversationId: conversation.id, userMessageId: userMsg.id });

  /* --- 1. Memory retrieval (internal — not a tool, so the loop stays single-tool) --- */
  const turns = store.buildTurnDocs();
  const retrieval = retrieveMemory(turns, userMessage, {
    timeZone,
    excludeTurnIds: new Set([userMsg.id]),
  });
  events.onMemory(retrieval.items);
  if (retrieval.items.length > 0) {
    log.info(`Recalled ${retrieval.items.length} memories for "${userMessage.slice(0, 60)}"`);
  }
  const sinceDays = sinceDaysHint(retrieval.temporal.references, retrieval.temporal.todayYmd);

  /* --- 2. Context assembly --- */
  const history: ChatMessage[] = conversation.messages
    .slice(0, -1) // current user message is added separately below
    .slice(-config.agent.historyMessages)
    .map((m) => ({ role: m.role, content: m.content }));

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(retrieval, sinceDays) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  /* --- 3. Model + tool loop --- */
  const allSources = new Map<string, Source>();
  let visible = '';
  let aborted = false;

  try {
    for (let iteration = 0; iteration < config.agent.maxToolIterations; iteration++) {
      const lastRound = iteration === config.agent.maxToolIterations - 1;
      const stream = await streamCompletion(
        {
          model: config.openai.model,
          messages,
          tools: TOOLS,
          tool_choice: lastRound ? 'none' : 'auto',
          temperature: config.agent.temperature,
          max_tokens: config.agent.maxTokens,
          stream: true,
        },
        signal,
      );

      let content = '';
      const calls = new Map<number, PendingToolCall>();
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          content += choice.delta.content;
          visible += choice.delta.content;
          events.onDelta(choice.delta.content);
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const pending = calls.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
            calls.set(idx, pending);
          }
        }
      }

      if (calls.size === 0) break; // final answer streamed

      /* Tool round: run every requested search in parallel, then continue the loop. */
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: [...calls.values()].map((c) => ({
          id: c.id || `call_${Math.random().toString(36).slice(2)}`,
          type: 'function' as const,
          function: { name: c.name, arguments: c.args },
        })),
      });

      const outcomes = await Promise.all(
        [...calls.values()].map(async (call) => {
          const label = queryLabelForStatus(call.args);
          events.onStatus(label ? `Searching the web: ${label}` : 'Searching the web…');
          if (call.name !== 'web_search') {
            return { call, outcome: { resultText: JSON.stringify({ error: `Unknown tool ${call.name}` }), sources: [] } };
          }
          const outcome = await executeSearchTool(call.args);
          return { call, outcome };
        }),
      );

      const newSources: Source[] = [];
      for (const { call, outcome } of outcomes) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.resultText });
        for (const source of outcome.sources) {
          if (!allSources.has(source.url)) {
            allSources.set(source.url, source);
            newSources.push(source);
          }
        }
      }
      if (newSources.length > 0) events.onSources(newSources);
    }
  } catch (err) {
    if (isAbort(err)) {
      aborted = true;
    } else {
      log.error('Agent loop failed', errorMessage(err));
      const note = `Sorry — something went wrong on my side: ${errorMessage(err).slice(0, 300)}`;
      if (visible.trim() === '') {
        visible = note;
        events.onDelta(note);
      } else {
        visible += `\n\n${note}`;
        events.onDelta(`\n\n${note}`);
      }
    }
  }

  if (visible.trim() === '') {
    visible = aborted ? '(stopped)' : 'I could not complete that answer — please try again.';
    events.onDelta(visible);
  }

  /* --- 4. Persist the answer --- */
  const assistantMessage = store.addMessage(conversation.id, {
    id: undefined,
    role: 'assistant',
    content: visible,
    sources: [...allSources.values()],
    model: config.openai.model,
  });

  /* --- 5. Background memory distillation (never blocks the response) --- */
  if (!aborted && visible.trim() !== '' && visible !== '(stopped)') {
    const turnDoc: TurnDoc = {
      id: userMsg.id,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      question: userMessage,
      answer: visible,
      askedAt: userMsg.createdAt,
      answeredAt: assistantMessage.createdAt,
      sources: [...allSources.values()],
    };
    void extractMemory({ turn: turnDoc })
      .then((memory) => {
        if (memory) store.setMemory(memory);
      })
      .catch(() => {
        /* extractMemory already logs; raw turn remains searchable */
      });
  }

  return {
    conversationId: conversation.id,
    assistantMessage,
    recalled: retrieval.items,
    sources: [...allSources.values()],
    aborted,
  };
}
