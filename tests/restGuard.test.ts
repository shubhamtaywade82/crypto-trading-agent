import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BACKOFF_MS,
  RestBackoffError,
  RestGuard,
  USDM_WEIGHT_LIMIT_PER_MINUTE,
  guardUsdmClient,
  isRateLimitError,
  isRestRefusal,
} from '../src/core/adapters/binance/restGuard.js';
import { RetryingMarketData } from '../src/core/adapters/decorators/marketData.js';

const MINUTE = 60_000;
/** A 13-digit epoch, minute-aligned, so the ban text carries a realistic millisecond timestamp. */
const START = 30_000_000 * MINUTE;

function clock(start = START) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

/** The shape the binance package throws for an HTTP error answer: no status, only code, message and headers. */
function venueError(code: number, headers: Record<string, string> = {}, message = 'Too many requests') {
  return { code, message, body: {}, headers, requestUrl: 'https://fapi.binance.com/fapi/v1/klines' };
}

test('a rate-limit answer is recognised by its code or its Retry-After header, and only those', () => {
  assert.equal(isRateLimitError(venueError(-1003)), true);
  assert.equal(isRateLimitError(venueError(-2011, { 'retry-after': '5' })), true);
  assert.equal(isRateLimitError(venueError(429)), true);
  assert.equal(isRateLimitError(venueError(-2011)), false, 'an ordinary venue rejection is not a rate limit');
  assert.equal(isRateLimitError(new Error('socket hang up')), false);
  assert.equal(isRestRefusal(new RestBackoffError(START + 1, 'test')), true);
});

test('Retry-After pauses every call for the wait it names, then lets the next one through', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  let reached = 0;
  const call = () => guard.call(async () => { reached += 1; return 'ok'; }, () => undefined);

  guard.observe(venueError(-1003, { 'retry-after': '30' }));
  await assert.rejects(call(), RestBackoffError);
  c.advance(29_000);
  await assert.rejects(call(), RestBackoffError);
  assert.equal(reached, 0, 'a refused call never reaches the venue');

  c.advance(2_000);
  assert.equal(await call(), 'ok');
  assert.equal(reached, 1);
});

test('the ban text names an absolute lift time, which wins when it is later than Retry-After', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  const liftsAt = START + 5 * MINUTE;

  guard.observe(venueError(-1003, { 'retry-after': '10' }, `IP banned until ${liftsAt}. Use WebSocket.`));

  assert.equal(guard.status().backoffUntil, liftsAt);
  await assert.rejects(guard.call(async () => 'ok', () => undefined), RestBackoffError);
});

test('a rate limit that names no wait falls back to the default backoff', () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  guard.observe(venueError(-1003));
  assert.equal(guard.status().backoffUntil, START + DEFAULT_BACKOFF_MS);
});

test('a backoff is never shortened by a later, smaller answer', () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  guard.observe(venueError(-1003, { 'retry-after': '120' }));
  guard.observe(venueError(-1003, { 'retry-after': '5' }));
  assert.equal(guard.status().backoffUntil, START + 120_000);
});

test('ordinary venue rejections do not open a backoff', async () => {
  const guard = new RestGuard({ now: clock().now });
  await assert.rejects(guard.call(async () => { throw venueError(-2011); }, () => undefined), (err) => (err as { code: number }).code === -2011);
  assert.equal(guard.status().backoffUntil, 0);
});

test('weight near its ceiling refuses calls until the minute rolls over', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  const weight = USDM_WEIGHT_LIMIT_PER_MINUTE * 0.95;

  // A response inside this minute reports the weight; the next call must be refused.
  assert.equal(await guard.call(async () => 'first', () => weight), 'first');
  await assert.rejects(guard.call(async () => 'second', () => weight), RestBackoffError);

  c.advance(MINUTE);
  // The reading is from the previous minute, so it no longer counts. The call goes out and refreshes it.
  assert.equal(await guard.call(async () => 'third', () => weight), 'third');
});

test('a stale weight reading never refuses calls forever, because refused calls cannot refresh it', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  // No response has arrived this minute, so the high reading is from before the window and is ignored.
  assert.equal(await guard.call(async () => 'ok', () => USDM_WEIGHT_LIMIT_PER_MINUTE), 'ok');
});

test('guardUsdmClient guards async REST methods, passes sync methods through, and leaves weight reads unguarded', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now });
  let klineCalls = 0;
  const client = {
    lastWeight: 7,
    async getKlines() {
      klineCalls += 1;
      throw venueError(-1003, { 'retry-after': '60' });
    },
    getRateLimitStates() {
      return { 'x-mbx-used-weight-1m': this.lastWeight };
    },
    scale(x: number) {
      return x * 2;
    },
  };
  const guarded = guardUsdmClient(client, guard);

  assert.equal(guarded.scale(21), 42, 'a synchronous method keeps its synchronous result');
  assert.equal(guarded.getRateLimitStates()['x-mbx-used-weight-1m'], 7);

  await assert.rejects(guarded.getKlines(), (err) => (err as { code: number }).code === -1003);
  assert.equal(klineCalls, 1);

  await assert.rejects(guarded.getKlines(), RestBackoffError);
  assert.equal(klineCalls, 1, 'the second call is refused locally and never reaches the venue');
  assert.equal(guarded.getRateLimitStates()['x-mbx-used-weight-1m'], 7, 'bookkeeping still works during a backoff');
});

test('the retry decorator does not retry a rate limit or a local backoff, but still retries an ordinary failure', async () => {
  let calls = 0;
  const failing = (error: unknown) => ({
    async getSnapshot() {
      calls += 1;
      throw error;
    },
  });
  const request = {} as never;
  const noSleep = async () => undefined;

  calls = 0;
  const limited = new RetryingMarketData(failing(venueError(-1003, { 'retry-after': '60' })) as never, {
    attempts: 3, backoffMs: 1, sleep: noSleep, shouldRetry: (e) => !isRestRefusal(e),
  });
  await assert.rejects(limited.getSnapshot(request), (err) => (err as { code: number }).code === -1003);
  assert.equal(calls, 1, 'a rate limit is attempted once');

  calls = 0;
  const transient = new RetryingMarketData(failing(new Error('socket hang up')) as never, {
    attempts: 3, backoffMs: 1, sleep: noSleep, shouldRetry: (e) => !isRestRefusal(e),
  });
  await assert.rejects(transient.getSnapshot(request), /socket hang up/);
  assert.equal(calls, 3, 'an ordinary failure keeps its retries');
});
