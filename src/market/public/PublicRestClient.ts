import { PUBLIC_REST_ENDPOINTS, resolvePublicRest, PublicOnlyViolation } from './endpointRegistry.js';

/** A failed public read. `status` is null when no response arrived (timeout, network). */
export class PublicRestError extends Error {
  constructor(message: string, readonly status: number | null, readonly endpointId: string) {
    super(message);
    this.name = 'PublicRestError';
  }
}

export interface PublicRestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Backoff applied on HTTP 429 or 418 when the venue sends no Retry-After. */
  defaultBackoffMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_MS = 60_000;

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Keyless GET client for the registry's endpoints. It sends no credential header and no signature, and it refuses any
 * request the registry does not name. After a 429 or 418 it sends nothing until the venue's backoff has passed.
 */
export class PublicRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly defaultBackoffMs: number;
  private backoffUntil = 0;

  constructor(options: PublicRestOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /** Milliseconds until the venue's backoff ends; 0 when no backoff holds. */
  backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - this.now());
  }

  async getJson(endpointId: string, query: Readonly<Record<string, string | number>> = {}): Promise<unknown> {
    const endpoint = PUBLIC_REST_ENDPOINTS.find((e) => e.id === endpointId);
    if (!endpoint) throw new PublicOnlyViolation(`unknown public endpoint "${endpointId}"`);
    const url = new URL(endpoint.path, endpoint.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: 'application/json' };
    resolvePublicRest('GET', url, headers);

    const remaining = this.backoffRemainingMs();
    if (remaining > 0) throw new PublicRestError(`${endpointId}: venue backoff holds for ${remaining} ms`, null, endpointId);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new PublicRestError(`${endpointId}: ${describe(err)}`, null, endpointId);
    }
    if (response.status === 429 || response.status === 418) {
      const retryAfterS = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : this.defaultBackoffMs;
      this.backoffUntil = this.now() + waitMs;
      throw new PublicRestError(`${endpointId}: HTTP ${response.status}, backing off ${waitMs} ms`, response.status, endpointId);
    }
    if (!response.ok) throw new PublicRestError(`${endpointId}: HTTP ${response.status}`, response.status, endpointId);
    try {
      return await response.json();
    } catch {
      throw new PublicRestError(`${endpointId}: body is not JSON`, response.status, endpointId);
    }
  }
}
