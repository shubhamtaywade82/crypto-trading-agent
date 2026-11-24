import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const TOKEN_USAGE_FILE = path.resolve('data/llm-usage.jsonl');

/** One LLM call as Ollama reported it; local and cloud calls alike, so local usage can be priced at cloud rates later. */
export interface TokenUsageRecord {
  at: number;
  /** The process that made the call (agent, fleet, research, ...). */
  source: string;
  host: string;
  endpoint: 'generate' | 'chat';
  model: string;
  promptTokens: number;
  outputTokens: number;
  ms: number;
  status: number;
}

const LLM_PATH = /\/api\/(generate|chat)$/;

/** Ollama's counts sit on the last JSON object: the whole body when not streaming, the final NDJSON line when streaming. */
export function usageFromBody(body: string): { model: string; promptTokens: number; outputTokens: number } | null {
  const last = body.trim().split('\n').at(-1);
  if (!last) return null;
  try {
    const json = JSON.parse(last) as { model?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
    if (typeof json.eval_count !== 'number') return null;
    return { model: String(json.model ?? ''), promptTokens: Number(json.prompt_eval_count ?? 0), outputTokens: json.eval_count };
  } catch {
    return null;
  }
}

/**
 * Wraps the global fetch, which every Ollama SDK client uses, so each /api/generate and /api/chat call appends its token
 * counts to `file` without touching the call sites. Recording never alters or fails the response the caller gets.
 */
export function installTokenUsageLog(source: string, file = TOKEN_USAGE_FILE): void {
  const inner = globalThis.fetch;
  mkdirSync(path.dirname(file), { recursive: true });
  let hasWarned = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const match = LLM_PATH.exec(url.pathname);
    if (!match) return inner(input, init);
    const started = Date.now();
    const res = await inner(input, init);
    void res.clone().text().then((body) => {
      const usage = usageFromBody(body);
      if (!usage) return;
      const record: TokenUsageRecord = {
        at: started, source, host: url.host, endpoint: match[1] as 'generate' | 'chat', ...usage, ms: Date.now() - started, status: res.status,
      };
      appendFileSync(file, `${JSON.stringify(record)}\n`);
    }).catch((err: unknown) => {
      if (hasWarned) return;
      hasWarned = true;
      console.warn(`[token-usage] not recorded (${(err as Error).message}); further failures are silent`);
    });
    return res;
  }) as typeof fetch;
}
