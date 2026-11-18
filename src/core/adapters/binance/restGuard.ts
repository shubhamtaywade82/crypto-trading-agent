/**
 * One process-wide gate in front of every USDⓈ-M REST client this process builds.
 *
 * Binance limits by IP, not by client, so the backoff state is shared: two clients with separate guards would keep
 * sending requests the other was told to stop. A rate-limit answer (code -1003, or a Retry-After header on 429/418)
 * pauses every REST call for the wait it names. Before each call the guard also refuses to send once this minute's
 * used weight nears its ceiling, so the window resets instead of being exceeded.
 *
 * Refused calls reject with RestBackoffError and never reach the venue. The package's thrown error carries no HTTP
 * status, so classification uses the Binance code and the Retry-After header.
 */

export const RATE_LIMIT_CODE = -1003;
/** Wait used when a rate-limit answer names none. Continued requests during a ban extend it, so the default is generous. */
export const DEFAULT_BACKOFF_MS = 60_000;
/** USDⓈ-M futures' per-IP request-weight limit per minute. The exchange's own rateLimits array is the authority. */
export const USDM_WEIGHT_LIMIT_PER_MINUTE = 2_400;
/** Fraction of the weight limit at which new calls are refused for the rest of the minute. */
export const WEIGHT_CEILING_RATIO = 0.9;

const MINUTE_MS = 60_000;
/** Read-only bookkeeping on the client, never a request to the venue. */
const UNGUARDED = new Set<PropertyKey>(['getRateLimitStates']);

export class RestBackoffError extends Error {
  readonly code = 'REST_BACKOFF';

  constructor(readonly until: number, reason: string) {
    super(`binance REST paused until ${new Date(until).toISOString()} (${reason})`);
    this.name = 'RestBackoffError';
  }
}

interface ErrorShape {
  code?: unknown;
  message?: unknown;
  headers?: Record<string, unknown> | null;
}

function shapeOf(err: unknown): ErrorShape | null {
  return typeof err === 'object' && err !== null ? (err as ErrorShape) : null;
}

function retryAfterMs(shape: ErrorShape): number | null {
  const raw = shape.headers?.['retry-after'];
  if (raw === undefined || raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Binance's ban text names the lift time in epoch milliseconds: "IP banned until 1700000000000". */
function bannedUntilMs(shape: ErrorShape): number | null {
  const text = typeof shape.message === 'string' ? shape.message : '';
  const match = /banned until (\d{13})/.exec(text);
  return match ? Number(match[1]) : null;
}

/** True for a rate-limit answer: -1003, a 418/429 code, or a Retry-After header. */
export function isRateLimitError(err: unknown): boolean {
  const shape = shapeOf(err);
  if (!shape) return false;
  if (shape.code === RATE_LIMIT_CODE || shape.code === 418 || shape.code === 429) return true;
  return retryAfterMs(shape) !== null;
}

/** True for any refusal that retrying cannot fix before the backoff lifts: a rate limit or a local backoff. */
export function isRestRefusal(err: unknown): boolean {
  return err instanceof RestBackoffError || isRateLimitError(err);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

export interface RestGuardOptions {
  now?: () => number;
  log?: (message: string) => void;
  weightLimit?: number;
}

export class RestGuard {
  private backoffUntil = 0;
  private backoffReason = '';
  /** When the last response (success or error) arrived. Used weight is only trusted from this minute. */
  private lastResponseAt = 0;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly weightLimit: number;

  constructor(options: RestGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.weightLimit = options.weightLimit ?? USDM_WEIGHT_LIMIT_PER_MINUTE;
  }

  /** The time until which calls are refused, and why. Zero when no backoff is set. */
  status(): { backoffUntil: number; reason: string } {
    return { backoffUntil: this.backoffUntil, reason: this.backoffReason };
  }

  /**
   * Throws RestBackoffError while a backoff holds, or when this minute's weight is at its ceiling. The weight reading
   * only counts once a response has arrived in the current minute. Otherwise a stale reading would refuse every call
   * forever, since refused calls never refresh it.
   */
  assertOpen(usedWeight: number | undefined): void {
    const now = this.now();
    if (now < this.backoffUntil) throw new RestBackoffError(this.backoffUntil, this.backoffReason);

    const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    if (usedWeight !== undefined && usedWeight >= this.weightLimit * WEIGHT_CEILING_RATIO && this.lastResponseAt >= minuteStart) {
      const until = minuteStart + MINUTE_MS;
      this.setBackoff(until, `request weight ${usedWeight}/${this.weightLimit} used this minute`);
      throw new RestBackoffError(until, this.backoffReason);
    }
  }

  /** Records a rate-limit answer as a backoff until the wait it names. Other errors are left alone. */
  observe(err: unknown): void {
    this.lastResponseAt = this.now();
    if (!isRateLimitError(err)) return;
    const shape = shapeOf(err) ?? {};
    const now = this.now();
    const candidates: number[] = [];
    const retryAfter = retryAfterMs(shape);
    if (retryAfter !== null) candidates.push(now + retryAfter);
    const banned = bannedUntilMs(shape);
    if (banned !== null) candidates.push(banned);
    const until = candidates.length > 0 ? Math.max(...candidates) : now + DEFAULT_BACKOFF_MS;
    this.setBackoff(until, `rate limited by Binance (code ${String(shape.code ?? 'none')})`);
  }

  /**
   * Runs `fn` under the guard. A refused call returns a rejected promise, since every USDⓈ-M REST method is async.
   * Synchronous methods pass through when no backoff holds.
   */
  call<T>(fn: () => T, usedWeight: () => number | undefined): T {
    try {
      this.assertOpen(usedWeight());
    } catch (err) {
      return Promise.reject(err) as unknown as T;
    }
    let out: T;
    try {
      out = fn();
    } catch (err) {
      this.observe(err);
      throw err;
    }
    if (isPromiseLike(out)) {
      return (out as unknown as Promise<unknown>).then(
        (value) => { this.lastResponseAt = this.now(); return value; },
        (err: unknown) => { this.observe(err); throw err; },
      ) as unknown as T;
    }
    this.lastResponseAt = this.now();
    return out;
  }

  private setBackoff(until: number, reason: string): void {
    if (until <= this.backoffUntil) return;
    const previouslyOpen = this.now() >= this.backoffUntil;
    this.backoffUntil = until;
    this.backoffReason = reason;
    if (previouslyOpen) this.log(`binance REST backoff: ${reason}; no REST calls until ${new Date(until).toISOString()}`);
  }
}

/** Shared by every live client in the process. Warnings go to stderr, which the fleet and orchestrator already read. */
export const sharedRestGuard = new RestGuard({ log: (message) => console.warn(`[binance] ${message}`) });

/**
 * Wraps a USDⓈ-M client so each REST method passes through the guard. The wrapper calls the method with the raw client
 * as `this`, so only the outer call is guarded and a method's internal calls are not counted twice.
 */
export function guardUsdmClient<T extends object>(client: T, guard: RestGuard = sharedRestGuard): T {
  const usedWeight = (): number | undefined => {
    const states = (client as { getRateLimitStates?: () => Record<string, number> }).getRateLimitStates?.();
    const value = states?.['x-mbx-used-weight-1m'];
    return typeof value === 'number' ? value : undefined;
  };
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function' || UNGUARDED.has(property)) return value;
      return (...args: unknown[]) => guard.call(
        () => (value as (...callArgs: unknown[]) => unknown).apply(target, args),
        usedWeight,
      );
    },
  });
}
