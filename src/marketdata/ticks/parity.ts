import { createHash } from 'node:crypto';

/** Stable JSON representation with recursively sorted keys to guarantee deterministic hashes. */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Canonical SHA-256 hash over reading, emitted events, and friction verdicts for tick replay parity verification. */
export function computeParityHash(reading: unknown, emitted: unknown[], friction?: unknown): string {
  const payload = { reading, emitted, friction };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}
