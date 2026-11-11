import type { ServerResponse } from 'node:http';

/**
 * Tiny Server-Sent Events writer.
 * Event framing: `event: <name>\ndata: <json>\n\n`
 */
export class SseWriter {
  private closed = false;

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
  }

  send(event: string, data: unknown): boolean {
    if (this.closed) return false;
    try {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  /** Keeps the connection alive through proxies that would otherwise time out. */
  ping(): void {
    if (!this.closed) {
      try {
        this.res.write(': ping\n\n');
      } catch {
        this.closed = true;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      /* already gone */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
