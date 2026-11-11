/* Minimi client — streaming SSE chat, memory inspector, sources, markdown. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    sidebar: $('sidebar'),
    conversationList: $('conversationList'),
    newChatBtn: $('newChatBtn'),
    themeBtn: $('themeBtn'),
    memoryBtn: $('memoryBtn'),
    memoryDrawer: $('memoryDrawer'),
    memoryClose: $('memoryClose'),
    memoryList: $('memoryList'),
    memoryQuery: $('memoryQuery'),
    memorySearchBtn: $('memorySearchBtn'),
    banner: $('banner'),
    chatTitle: $('chatTitle'),
    providerBadge: $('providerBadge'),
    messages: $('messages'),
    welcome: $('welcome'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    examples: document.querySelectorAll('.example'),
  };

  const state = {
    conversationId: null,
    conversations: [],
    streaming: false,
    controller: null,
    tz: 'UTC',
    theme: 'dark',
    memoryItems: [],
  };

  /* -------------------------------------------------------------- */
  /* Safe markdown: escape first, then add structure.                */
  /* -------------------------------------------------------------- */

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHref(url) {
    const trimmed = String(url).trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : '';
  }

  function renderInline(escaped) {
    let out = escaped;
    // inline code
    out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
    // images -> plain links (no remote images in chat)
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>` : m;
    });
    // links
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
    });
    // bare urls
    out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (m, pre, url) => {
      const href = safeHref(url);
      return href ? `${pre}<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>` : m;
    });
    // bold / italic
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function renderMarkdown(text) {
    const lines = escapeHtml(text ?? '').split('\n');
    const html = [];
    let inCode = false;
    let listType = null; // 'ul' | 'ol'
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length > 0) {
        html.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
        paragraph = [];
      }
    };
    const closeList = () => {
      if (listType) {
        html.push(`</${listType}>`);
        listType = null;
      }
    };

    for (const line of lines) {
      const fence = line.match(/^```(\w*)$/);
      if (fence) {
        flushParagraph();
        closeList();
        if (!inCode) {
          inCode = true;
          html.push('<pre><code>');
        } else {
          inCode = false;
          html.push('</code></pre>');
        }
        continue;
      }
      if (inCode) {
        html.push(`${line}\n`);
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = Math.min(heading[1].length + 1, 4);
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (listType !== 'ul') {
          closeList();
          html.push('<ul>');
          listType = 'ul';
        }
        html.push(`<li>${renderInline(bullet[1])}</li>`);
        continue;
      }

      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (numbered) {
        flushParagraph();
        if (listType !== 'ol') {
          closeList();
          html.push('<ol>');
          listType = 'ol';
        }
        html.push(`<li>${renderInline(numbered[1])}</li>`);
        continue;
      }

      const quote = line.match(/^&gt;\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }

      if (line.trim() === '') {
        flushParagraph();
        closeList();
        continue;
      }

      closeList();
      paragraph.push(line);
    }

    if (inCode) html.push('</code></pre>');
    flushParagraph();
    closeList();
    return html.join('');
  }

  /* -------------------------------------------------------------- */
  /* Small helpers                                                   */
  /* -------------------------------------------------------------- */

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function timeLabel(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function isNearBottom() {
    const el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollToBottom(force = false) {
    if (force || isNearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  /* -------------------------------------------------------------- */
  /* Sidebar                                                         */
  /* -------------------------------------------------------------- */

  async function loadConversations() {
    const response = await fetch('/api/conversations');
    const data = await response.json();
    state.conversations = data.conversations ?? [];
    renderSidebar();
  }

  function renderSidebar() {
    els.conversationList.replaceChildren();
    for (const conversation of state.conversations) {
      const item = document.createElement('div');
      item.className = 'conv-item' + (conversation.id === state.conversationId ? ' active' : '');

      const title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = conversation.title || 'Untitled';

      const date = document.createElement('span');
      date.className = 'conv-date';
      date.textContent = timeLabel(conversation.updatedAt);

      const del = document.createElement('button');
      del.className = 'conv-delete';
      del.title = 'Delete conversation';
      del.textContent = '✕';
      del.addEventListener('click', async (event) => {
        event.stopPropagation();
        await fetch(`/api/conversations/${conversation.id}`, { method: 'DELETE' });
        if (state.conversationId === conversation.id) newChat();
        await loadConversations();
      });

      item.append(title, date, del);
      item.addEventListener('click', () => openConversation(conversation.id));
      els.conversationList.append(item);
    }
  }

  async function openConversation(id) {
    if (state.streaming) return;
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) return;
    const { conversation } = await response.json();
    state.conversationId = id;
    els.chatTitle.textContent = conversation.title || 'Untitled';
    els.welcome.classList.add('hidden');
    els.messages.querySelectorAll('.msg-row').forEach((row) => row.remove());

    for (const message of conversation.messages) {
      if (message.role === 'user') appendUserMessage(message.content, message.createdAt);
      else appendAssistantMessage(message.content, message.sources ?? [], message.createdAt, { static: true });
    }
    renderSidebar();
    scrollToBottom(true);
  }

  function newChat() {
    if (state.streaming) return;
    state.conversationId = null;
    els.chatTitle.textContent = 'New chat';
    els.messages.querySelectorAll('.msg-row').forEach((row) => row.remove());
    els.welcome.classList.remove('hidden');
    renderSidebar();
    els.input.focus();
  }

  /* -------------------------------------------------------------- */
  /* Message rendering                                               */
  /* -------------------------------------------------------------- */

  function appendUserMessage(text, createdAt) {
    els.welcome.classList.add('hidden');
    const row = document.createElement('div');
    row.className = 'msg-row user';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    const avatar = document.createElement('div');
    avatar.className = 'avatar user';
    avatar.textContent = 'you'.slice(0, 1).toUpperCase();

    row.append(avatar, bubble);
    els.messages.append(row);
    scrollToBottom(true);
    return row;
  }

  function appendAssistantMessage(text, sources = [], createdAt = null, opts = {}) {
    const row = document.createElement('div');
    row.className = 'msg-row assistant';

    const avatar = document.createElement('div');
    avatar.className = 'avatar assistant';
    avatar.textContent = '◆';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const body = document.createElement('div');
    body.className = 'msg-body';

    const sourceRow = document.createElement('div');
    sourceRow.className = 'source-row';

    bubble.append(meta, body, sourceRow);
    row.append(avatar, bubble);
    els.messages.append(row);

    const message = {
      row,
      bubble,
      meta,
      body,
      sourceRow,
      text: text ?? '',
      sources: [...sources],
      stopped: false,
      render({ showCursor = false } = {}) {
        this.body.innerHTML = renderMarkdown(this.text) + (showCursor ? '<span class="cursor"></span>' : '');
        this.sourceRow.replaceChildren(...this.sources.map(sourceCard));
        scrollToBottom();
      },
    };

    if (createdAt) {
      const time = document.createElement('span');
      time.className = 'chip';
      time.textContent = timeLabel(createdAt);
      meta.append(time);
    }
    message.render();
    if (opts.static) scrollToBottom();
    return message;
  }

  function sourceCard(source) {
    const card = document.createElement('a');
    card.className = 'source-card';
    card.href = safeHref(source.url) || '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.title = source.title || source.url;

    const domain = document.createElement('span');
    domain.className = 'source-domain';
    domain.textContent = domainOf(source.url);

    const title = document.createElement('span');
    title.className = 'source-title';
    title.textContent = source.title || '(untitled)';

    card.append(domain, title);
    if (source.publishedDate) {
      const date = document.createElement('span');
      date.className = 'source-published';
      date.textContent = source.publishedDate;
      card.append(date);
    }
    return card;
  }

  function setStatusChip(message, text, sticky = false) {
    let chip = message.meta.querySelector('.chip.status');
    if (!text) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'chip status';
      message.meta.append(chip);
    }
    chip.innerHTML = `${escapeHtml(text)}<span class="dots"></span>`;
    message.row.dataset.stickyStatus = sticky ? '1' : '';
    scrollToBottom();
  }

  function clearStatusChip(message) {
    const chip = message.meta.querySelector('.chip.status');
    if (chip && !message.row.dataset.stickyStatus) chip.remove();
  }

  function setMemoryChip(message, count) {
    if (!count) return;
    const chip = document.createElement('span');
    chip.className = 'chip memory';
    chip.textContent = `🧠 recalled ${count} past ${count === 1 ? 'conversation' : 'conversations'}`;
    chip.title = 'Past turns retrieved from memory for this answer';
    chip.addEventListener('click', () => {
      openMemoryDrawer('');
      els.memoryQuery.value = '';
    });
    message.meta.append(chip);
  }

  /* -------------------------------------------------------------- */
  /* Streaming chat                                                  */
  /* -------------------------------------------------------------- */

  function setStreaming(streaming) {
    state.streaming = streaming;
    els.sendBtn.classList.toggle('hidden', streaming);
    els.stopBtn.classList.toggle('hidden', !streaming);
    els.input.disabled = false;
  }

  async function sendMessage(text) {
    if (state.streaming || !text.trim()) return;
    appendUserMessage(text);
    els.input.value = '';
    autoResize();

    const message = appendAssistantMessage('');
    message.render({ showCursor: true });
    setStreaming(true);
    els.chatTitle.textContent = text.length > 48 ? `${text.slice(0, 48)}…` : text;

    const controller = new AbortController();
    state.controller = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: state.conversationId,
          message: text,
          timezone: state.tz,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let frameCount = 0;
      let renderScheduled = false;

      const renderSoon = () => {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
          renderScheduled = false;
          message.render({ showCursor: true });
        });
      };

      const handleFrame = (frame) => {
        let eventName = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        let payload;
        try {
          payload = JSON.parse(dataLines.join('\n'));
        } catch {
          return;
        }
        frameCount += 1;

        switch (eventName) {
          case 'meta':
            state.conversationId = payload.conversationId;
            break;
          case 'memory':
            setMemoryChip(message, payload.count);
            if (payload.count > 0) scrollToBottom();
            break;
          case 'status':
            setStatusChip(message, payload.text);
            break;
          case 'delta':
            message.text += payload.text ?? '';
            renderSoon();
            break;
          case 'sources':
            for (const source of payload.sources ?? []) {
              if (!message.sources.some((s) => s.url === source.url)) message.sources.push(source);
            }
            renderSoon();
            break;
          case 'done':
            if (state.conversationId !== payload.conversationId) state.conversationId = payload.conversationId;
            break;
          case 'error':
            message.text += `${message.text ? '\n\n' : ''}⚠️ ${payload.message ?? 'Something went wrong.'}`;
            break;
          default:
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.trim()) handleFrame(frame);
        }
      }

      clearStatusChip(message);
      message.render();
      scrollToBottom();
    } catch (err) {
      if (err.name === 'AbortError') {
        message.text += message.text ? '\n\n_(stopped)_' : '_(stopped)_';
      } else {
        message.text += `${message.text ? '\n\n' : ''}⚠️ ${err.message || 'Request failed.'}`;
        message.body.classList.add('error-text');
      }
      message.render();
    } finally {
      setStreaming(false);
      state.controller = null;
      void loadConversations();
    }
  }

  /* -------------------------------------------------------------- */
  /* Memory drawer                                                   */
  /* -------------------------------------------------------------- */

  async function openMemoryDrawer(query) {
    els.memoryDrawer.classList.remove('hidden');
    els.memoryQuery.value = query ?? '';
    await refreshMemory();
  }

  async function refreshMemory() {
    const query = els.memoryQuery.value.trim();
    const params = new URLSearchParams({ tz: state.tz });
    if (query) params.set('q', query);
    const response = await fetch(`/api/memory?${params.toString()}`);
    const data = await response.json();
    state.memoryItems = data.memories ?? [];

    els.memoryList.replaceChildren();
    if (state.memoryItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'memory-empty';
      empty.textContent = query
        ? 'No memories match — try a date like "what did I ask on 3 November" or a topic like "Postgres hosting".'
        : 'No memories yet. Chat with the agent and every turn gets distilled here.';
      els.memoryList.append(empty);
      return;
    }

    for (const memory of state.memoryItems) {
      const item = document.createElement('div');
      item.className = 'memory-item';

      const date = document.createElement('div');
      date.className = 'memory-date';
      date.textContent = `${memory.dateLabel} · ${memory.matchedReference ? `matched "${memory.matchedReference}"` : timeLabel(memory.askedAt)}`;

      const q = document.createElement('p');
      q.className = 'memory-q';
      q.textContent = memory.question;

      const a = document.createElement('p');
      a.className = 'memory-a';
      a.textContent = memory.answer || '(no recorded answer)';

      item.append(date, q, a);

      if (memory.entities?.length > 0) {
        const entities = document.createElement('div');
        entities.className = 'memory-entities';
        for (const entity of memory.entities) {
          const tag = document.createElement('span');
          tag.className = 'memory-entity';
          tag.textContent = entity;
          entities.append(tag);
        }
        item.append(entities);
      }

      if (memory.claims?.length > 0) {
        const claims = document.createElement('ul');
        claims.className = 'memory-claims';
        for (const claim of memory.claims) {
          const li = document.createElement('li');
          li.textContent = claim.text + (claim.timeSensitive ? '  ⟨time-sensitive⟩' : '');
          claims.append(li);
        }
        item.append(claims);
      }

      if (memory.sources?.length > 0) {
        const sources = document.createElement('div');
        sources.className = 'memory-entities';
        for (const source of memory.sources.slice(0, 4)) {
          const link = document.createElement('a');
          link.className = 'memory-entity';
          link.href = source.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = domainOf(source.url);
          sources.append(link);
        }
        item.append(sources);
      }

      els.memoryList.append(item);
    }
  }

  /* -------------------------------------------------------------- */
  /* Health banner + theme                                           */
  /* -------------------------------------------------------------- */

  async function loadHealth() {
    const response = await fetch('/api/health');
    const health = await response.json();
    els.providerBadge.textContent = `${health.model} · ${health.searchProvider}`;
    els.providerBadge.title = `Model: ${health.model} · Search: ${health.searchProvider}`;
    if ((health.warnings ?? []).length > 0) {
      els.banner.classList.remove('hidden');
      els.banner.innerHTML =
        `<strong>Setup needed:</strong> ${escapeHtml(health.warnings[0])} ` +
        `See <a href="https://github.com" target="_blank" rel="noopener">.env.example</a> in the repo for instructions.`;
    }
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('minimi-theme', theme);
    } catch {
      /* private mode */
    }
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  }

  /* -------------------------------------------------------------- */
  /* Wiring                                                          */
  /* -------------------------------------------------------------- */

  function init() {
    try {
      state.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      state.tz = 'UTC';
    }
    applyTheme((() => {
      try {
        return localStorage.getItem('minimi-theme') || 'dark';
      } catch {
        return 'dark';
      }
    })());

    els.sendBtn.addEventListener('click', () => sendMessage(els.input.value));
    els.stopBtn.addEventListener('click', () => state.controller?.abort());
    els.newChatBtn.addEventListener('click', newChat);
    els.themeBtn.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
    els.memoryBtn.addEventListener('click', () => openMemoryDrawer(''));
    els.memoryClose.addEventListener('click', () => els.memoryDrawer.classList.add('hidden'));
    els.memorySearchBtn.addEventListener('click', refreshMemory);
    els.memoryQuery.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') refreshMemory();
    });

    els.input.addEventListener('input', autoResize);
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(els.input.value);
      }
    });

    for (const button of els.examples) {
      button.addEventListener('click', () => {
        els.input.value = button.dataset.text ?? '';
        els.input.focus();
        autoResize();
      });
    }

    void loadHealth();
    void loadConversations();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
