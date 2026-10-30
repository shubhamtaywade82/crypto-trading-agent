/**
 * HTTP client for Ollama's decision endpoint: POST {host}/v1/systemone.
 *
 * The @nemesis-oss/ollama-sdk used by the rest of this repo speaks /api/generate
 * and /api/tags only; the Jev-style decision API is a separate endpoint, so this
 * client uses raw fetch following scripts/test-ollama-cloud.ts: Bearer auth when
 * an API key is configured (cloud hosts), AbortController for the timeout, and a
 * typed error so callers can fail closed without parsing prose.
 *
 * The client is transport only: it validates the envelope shape and never
 * interprets answers — that is the evaluator's job.
 */

import type { SystemoneRequest, SystemoneResponse } from '../types.js';

export type Tev1ErrorKind = 'timeout' | 'http' | 'network' | 'invalid_response';

export class Tev1ClientError extends Error {
  readonly kind: Tev1ErrorKind;
  readonly status?: number;
  constructor(kind: Tev1ErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'Tev1ClientError';
    this.kind = kind;
    this.status = status;
  }
}

/** The slice of fetch this client needs; injectable so tests never open a socket. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Tev1ClientOptions {
  /** Ollama base URL, e.g. http://127.0.0.1:11434 (no trailing path). */
  host: string;
  /** Optional: required by cloud-hosted Ollama, ignored by a local daemon. */
  apiKey?: string;
  /** Per-request budget. A decision the loop is waiting on must fail fast, not stall the tick. */
  timeoutMs: number;
  /** Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface Tev1Client {
  systemone(request: SystemoneRequest): Promise<SystemoneResponse>;
}

export class HttpTev1Client implements Tev1Client {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: Tev1ClientOptions) {
    this.url = `${options.host.replace(/\/+$/, '')}/v1/systemone`;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async systemone(request: SystemoneRequest): Promise<SystemoneResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Tev1ClientError('timeout', `systemone request timed out after ${this.timeoutMs}ms`);
      }
      throw new Tev1ClientError('network', `systemone request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Tev1ClientError('http', `systemone responded HTTP ${response.status}: ${body.slice(0, 200)}`, response.status);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new Tev1ClientError('invalid_response', `systemone response is not JSON: ${(err as Error).message}`);
    }
    return validateEnvelope(parsed);
  }
}

/** Structural check of the response envelope; semantic validation of each answer lives in the evaluator. */
function validateEnvelope(parsed: unknown): SystemoneResponse {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Tev1ClientError('invalid_response', 'systemone response is not an object');
  }
  const candidate = parsed as { model?: unknown; answers?: unknown; usage?: unknown };
  if (typeof candidate.answers !== 'object' || candidate.answers === null || Array.isArray(candidate.answers)) {
    throw new Tev1ClientError('invalid_response', 'systemone response has no answers object');
  }
  if (candidate.model !== undefined && typeof candidate.model !== 'string') {
    throw new Tev1ClientError('invalid_response', 'systemone response model field is not a string');
  }
  return parsed as SystemoneResponse;
}
