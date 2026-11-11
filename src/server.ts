import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configProblems } from './config';
import { store } from './memory/store';
import { recentMemories, retrieveMemory } from './memory/retrieve';
import { runChat } from './agent/loop';
import { SseWriter } from './util/sse';
import { isValidTimeZone } from './memory/dates';
import { errorMessage, logger } from './util/log';

const log = logger('server');
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STATIC_FILES = new Set(['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg']);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') {
    sendJson(res, 200, {
      ok: true,
      model: config.openai.model,
      searchProvider: config.search.provider,
      timezone: config.timezone,
      warnings: configProblems(),
    });
    return;
  }

  if (route === 'GET /api/conversations') {
    sendJson(res, 200, { conversations: store.listConversations() });
    return;
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    const id = decodeURIComponent(conversationMatch[1] ?? '');
    if (req.method === 'GET') {
      const conversation = store.getConversation(id);
      if (!conversation) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, { conversation });
    }
    if (req.method === 'DELETE') {
      const deleted = store.deleteConversation(id);
      return sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Not found' });
    }
  }

  if (route === 'GET /api/memory') {
    const q = (url.searchParams.get('q') ?? '').trim();
    const timezone = url.searchParams.get('tz') || config.timezone;
    const turns = store.buildTurnDocs();
    if (!q) {
      sendJson(res, 200, { memories: recentMemories(turns, timezone), query: '', dateScoped: false });
      return;
    }
    const result = retrieveMemory(turns, q, { timeZone: timezone });
    sendJson(res, 200, {
      memories: result.items,
      query: q,
      dateScoped: result.dateScoped,
      references: result.temporal.references,
    });
    return;
  }

  if (route === 'POST /api/chat') {
    let payload: { conversationId?: string; message?: string; timezone?: string };
    try {
      payload = JSON.parse((await readBody(req)).toString() || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const message = (payload.message ?? '').trim();
    if (!message) return sendJson(res, 400, { error: 'message is required' });
    if (message.length > 20_000) return sendJson(res, 400, { error: 'message too long' });
    const timeZone = isValidTimeZone(payload.timezone ?? '') ? (payload.timezone ?? config.timezone) : config.timezone;

    const sse = new SseWriter(res);
    const controller = new AbortController();
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      controller.abort();
    };
    req.on('close', onClose);

    try {
      const result = await runChat({
        conversationId: payload.conversationId,
        userMessage: message,
        timeZone,
        signal: controller.signal,
        events: {
          onMeta: (meta) => sse.send('meta', meta),
          onMemory: (items) =>
            sse.send('memory', {
              count: items.length,
              items: items.map((m) => ({
                dateLabel: m.dateLabel,
                askedAt: m.askedAt,
                question: m.question.slice(0, 160),
              })),
            }),
          onStatus: (text) => sse.send('status', { text }),
          onDelta: (text) => sse.send('delta', { text }),
          onSources: (sources) => sse.send('sources', { sources }),
        },
      });
      sse.send('done', {
        conversationId: result.conversationId,
        messageId: result.assistantMessage.id,
        sources: result.sources,
        recalledCount: result.recalled.length,
        aborted: result.aborted,
      });
    } catch (err) {
      log.error('Chat failed', errorMessage(err));
      sse.send('error', { message: errorMessage(err).slice(0, 500) });
    } finally {
      req.off('close', onClose);
      if (!clientGone) sse.close();
    }
    return;
  }

  sendJson(res, 404, { error: `No route for ${route}` });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
      await serveStatic(res, url.pathname);
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(res, '/'); // SPA-ish: everything else renders the app
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log.error(`Unhandled error on ${req.method} ${url.pathname}`, errorMessage(err));
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    else res.end();
  }
});

server.on('clientError', (err, socket) => {
  log.warn('Client error', errorMessage(err));
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

async function main(): Promise<void> {
  await store.init();
  server.on('error', (err) => {
    const code = (err as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      log.error(`Port ${config.port} is already in use. Start on another port, e.g.: PORT=3123 npm run dev`);
      process.exit(1);
    }
    log.error('Server error', errorMessage(err));
    process.exit(1);
  });
  server.listen(config.port, () => {
    log.info(`Minimi listening on http://localhost:${config.port}`);
    for (const problem of configProblems()) log.warn(problem);
  });
}

const shuttingDown = { done: false };
function shutdown(signalName: string): void {
  if (shuttingDown.done) return;
  shuttingDown.done = true;
  log.info(`${signalName} received — flushing state and closing`);
  server.close(() => process.exit(0));
  void store.flush().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void main();
