import { randomUUID } from 'node:crypto';

/** Short, prefixed, sortable-enough id. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
}
