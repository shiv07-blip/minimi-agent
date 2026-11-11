import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { newId } from '../util/ids';
import { logger } from '../util/log';

const log = logger('store');

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Source {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  accessedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  sources?: Source[];
  model?: string;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

/** Structured distillation of one turn, written by the background memory extractor. */
export interface ExtractedMemory {
  turnId: string;
  conversationId: string;
  createdAt: string;
  topic: string;
  entities: string[];
  question: string;
  answerSummary: string;
  claims: Array<{ text: string; sourceUrl?: string; timeSensitive: boolean }>;
  tags: string[];
  extractionModel: string;
}

interface State {
  version: 1;
  conversations: Record<string, Conversation>;
  memories: Record<string, ExtractedMemory>;
}

/** One question/answer pair from history, enriched with its extracted memory if any. */
export interface TurnDoc {
  id: string;
  conversationId: string;
  conversationTitle: string;
  question: string;
  answer: string;
  askedAt: string; // ISO timestamp of the user message
  answeredAt: string; // ISO timestamp of the assistant message
  sources: Source[];
  memory?: ExtractedMemory;
}

const EMPTY_STATE: State = { version: 1, conversations: {}, memories: {} };

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export class Store {
  private state: State = { ...EMPTY_STATE, conversations: {}, memories: {} };
  private turnDocs: TurnDoc[] | null = null; // invalidated on write
  private saveTimer: NodeJS.Timeout | null = null;
  private file: string;

  constructor(dataDir: string = config.dataDir) {
    this.file = path.resolve(dataDir, 'state.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as State;
      this.state = { ...EMPTY_STATE, ...parsed };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') log.warn('Could not load state.json, starting fresh', String(err));
    }
    log.info(`Store ready: ${this.conversationCount()} conversations, ${this.turnCount()} turns`);
  }

  /* --- persistence (atomic, debounced) --- */

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 250);
    this.saveTimer.unref?.();
  }

  async flush(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.state), 'utf8');
      await fs.rename(tmp, this.file);
    } catch (err) {
      log.error('Failed to persist state', String(err));
    }
  }

  private touch(): void {
    this.turnDocs = null;
    this.scheduleSave();
  }

  /* --- conversations --- */

  conversationCount(): number {
    return Object.keys(this.state.conversations).length;
  }

  turnCount(): number {
    return Object.values(this.state.conversations).reduce((n, c) => n + c.messages.length, 0);
  }

  createConversation(title = 'New chat'): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: newId('conv'),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.conversations[conversation.id] = conversation;
    this.touch();
    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    return this.state.conversations[id];
  }

  listConversations(): Array<Pick<Conversation, 'id' | 'title' | 'createdAt' | 'updatedAt'> & { messageCount: number }> {
    return Object.values(this.state.conversations)
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  deleteConversation(id: string): boolean {
    const conversation = this.state.conversations[id];
    if (!conversation) return false;
    delete this.state.conversations[id];
    for (const [turnId, mem] of Object.entries(this.state.memories)) {
      if (mem.conversationId === id) delete this.state.memories[turnId];
    }
    this.touch();
    return true;
  }

  /* --- messages --- */

  addMessage(conversationId: string, message: Omit<Message, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Message {
    const conversation = this.state.conversations[conversationId];
    if (!conversation) throw new Error(`No conversation ${conversationId}`);
    const full: Message = {
      id: message.id ?? newId('msg'),
      createdAt: message.createdAt ?? new Date().toISOString(),
      role: message.role,
      content: message.content,
      ...(message.sources ? { sources: message.sources } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.error ? { error: message.error } : {}),
    };
    conversation.messages.push(full);
    conversation.updatedAt = full.createdAt;
    this.touch();
    return full;
  }

  updateMessage(conversationId: string, messageId: string, patch: Partial<Message>): Message | undefined {
    const conversation = this.state.conversations[conversationId];
    const message = conversation?.messages.find((m) => m.id === messageId);
    if (!message) return undefined;
    Object.assign(message, patch);
    conversation!.updatedAt = new Date().toISOString();
    this.touch();
    return message;
  }

  renameConversation(id: string, title: string): void {
    const conversation = this.state.conversations[id];
    if (!conversation) return;
    conversation.title = title;
    this.touch();
  }

  /* --- extracted memories --- */

  setMemory(memory: ExtractedMemory): void {
    this.state.memories[memory.turnId] = memory;
    this.touch();
  }

  listMemories(): ExtractedMemory[] {
    return Object.values(this.state.memories).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /* --- derived turn documents (the retrieval corpus) --- */

  buildTurnDocs(): TurnDoc[] {
    if (this.turnDocs) return this.turnDocs;
    const docs: TurnDoc[] = [];
    for (const conversation of Object.values(this.state.conversations)) {
      let pending: { user: Message } | null = null;
      const push = (user: Message, assistant?: Message) => {
        docs.push({
          id: user.id,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          question: user.content,
          answer: assistant?.content ?? '',
          askedAt: user.createdAt,
          answeredAt: assistant?.createdAt ?? user.createdAt,
          sources: assistant?.sources ?? [],
          memory: this.state.memories[user.id],
        });
      };
      for (const message of conversation.messages) {
        if (message.role === 'user') {
          if (pending) push(pending.user);
          pending = { user: message };
        } else if (pending) {
          push(pending.user, message);
          pending = null;
        }
      }
      if (pending) push(pending.user);
    }
    docs.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    this.turnDocs = docs;
    return docs;
  }
}

/* Shared singleton for the server process. */
export const store = new Store();
