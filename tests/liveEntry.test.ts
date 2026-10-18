import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntryRecord } from '../src/binance/liveBook.js';
import { isWorking, LiveEntryTracker, liveEntryClientOrderId, orderSideOf, venueRejected, type LegIds, type LiveEntryJob, type LiveEntryPort } from '../src/binance/liveEntry.js';
import { OrderInFlightError } from '../src/binance/remoteOrders.js';

const JOB: LiveEntryJob = {
  symbol: 'SOLUSDT', side: 'LONG', clientOrderId: 'e-test-1', strategy: 'STRUCTURE-TREND-η',
  stopLoss: 95, takeProfit: 110, decisionId: 'd1', submittedAt: 0,
};
const TTL = 3_000;
const POLL = 1_000;

/**
 * A fake venue. `script` runs once per sleep, so a test scripts what the exchange does between two polls. Each sleep
 * advances the clock, which makes TTL and the poll cadence deterministic. `onCancel` decides what a cancel does.
 */
class FakeVenue implements LiveEntryPort {
  status = 'NEW';
  executedQty = 0;
  held = 0;
  calls: string[] = [];
  script: Array<(venue: FakeVenue) => void> = [];
  readFailures = 0;
  placeFailures = 0;
  flattenFailures = 0;
  cancelLegsFailures = 0;
  onCancel: (venue: FakeVenue) => void = (venue) => { venue.status = 'CANCELED'; };
  nextLegId = 100;
  tracker!: LiveEntryTracker;

  async orderState() {
    if (this.readFailures > 0) { this.readFailures--; throw new Error('read timed out'); }
    return { status: this.status, executedQty: this.executedQty };
  }

  async cancelOrder() {
    this.calls.push('cancelOrder');
    this.onCancel(this);
  }

  async positionQty() {
    return this.held;
  }

  async placeLegs(_job: LiveEntryJob, qty: number): Promise<LegIds> {
    this.calls.push(`placeLegs:${qty}`);
    if (this.placeFailures > 0) { this.placeFailures--; throw new Error('stop rejected'); }
    const stopOrderId = this.nextLegId;
    this.nextLegId += 2;
    return { stopOrderId, tpOrderId: stopOrderId + 1 };
  }

  async cancelLegs(_symbol: string, legs: LegIds) {
    this.calls.push(`cancelLegs:${legs.stopOrderId}`);
    if (this.cancelLegsFailures > 0) { this.cancelLegsFailures--; throw new Error('cancel timed out'); }
  }

  async cancelAllOpen() {
    this.calls.push('cancelAllOpen');
  }

  async flatten(_symbol: string, side: string, qty: number) {
    this.calls.push(`flatten:${side}:${qty}`);
    if (this.flattenFailures > 0) { this.flattenFailures--; throw new Error('reduce-only rejected'); }
    this.held = 0;
  }

  recordEntry(entry: EntryRecord) {
    this.calls.push(`recordEntry:${entry.stopOrderId}`);
  }
}

function run(venue: FakeVenue) {
  let now = 0;
  const logs: string[] = [];
  const tracker = new LiveEntryTracker(venue, {
    ttlMs: TTL,
    pollMs: POLL,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      assert.ok(now < 60_000, 'runaway loop: the entry never resolved');
      venue.script.shift()?.(venue);
    },
    log: (message, level) => logs.push(`${level} ${message}`),
  });
  venue.tracker = tracker;
  return { tracker, logs, done: tracker.track(JOB) };
}

test('a full fill places one set of legs for the position, records the entry, and resolves', async () => {
  const venue = new FakeVenue();
  venue.script = [(v) => { v.status = 'FILLED'; v.executedQty = 1; v.held = 1; }];
  const { done, logs } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['placeLegs:1', 'recordEntry:100']);
  assert.equal(venue.tracker.busy, false);
  assert.match(logs.join('\n'), /FILLED: executed 1, protected 1/);
});

test('a partial fill then the rest: new legs go up for the final size before the old ones are cancelled', async () => {
  const venue = new FakeVenue();
  venue.script = [
    (v) => { v.status = 'PARTIALLY_FILLED'; v.executedQty = 0.4; v.held = 0.4; },
    (v) => { v.status = 'FILLED'; v.executedQty = 1; v.held = 1; },
  ];
  const { done } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['placeLegs:0.4', 'recordEntry:100', 'placeLegs:1', 'recordEntry:102', 'cancelLegs:100']);
  assert.equal(venue.tracker.busy, false);
});

test('no fill before the TTL: the entry is cancelled, no legs are placed, and it resolves as not filled', async () => {
  const venue = new FakeVenue();
  const { done, logs } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['cancelOrder']);
  assert.match(logs.join('\n'), /not filled within 3000 ms: cancel sent/);
  assert.match(logs.join('\n'), /CANCELED: executed 0, no position/);
});

test('a fill that lands just before the cancel is accepted is protected, not dropped', async () => {
  const venue = new FakeVenue();
  venue.onCancel = (v) => { v.status = 'CANCELED'; v.executedQty = 0.4; v.held = 0.4; };
  const { done } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['cancelOrder', 'placeLegs:0.4', 'recordEntry:100']);
  assert.equal(venue.tracker.busy, false);
});

test('a failed protection cancels the open orders and flattens the position, then resolves', async () => {
  const venue = new FakeVenue();
  venue.placeFailures = 1;
  venue.script = [(v) => { v.status = 'FILLED'; v.executedQty = 1; v.held = 1; }];
  const { done, logs } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['placeLegs:1', 'cancelAllOpen', 'flatten:LONG:1']);
  assert.equal(venue.held, 0);
  assert.equal(venue.tracker.busy, false);
  assert.match(logs.join('\n'), /UNPROTECTED 1: protection failed/);
});

test('when the flatten also fails the entry stays busy and the flatten is retried until it succeeds', async () => {
  const venue = new FakeVenue();
  venue.placeFailures = 2;
  venue.flattenFailures = 1;
  const observed: boolean[] = [];
  venue.script = [
    (v) => { v.status = 'FILLED'; v.executedQty = 1; v.held = 1; },
    (v) => observed.push(v.tracker.busy),
    (v) => observed.push(v.tracker.busy),
  ];
  const { done } = run(venue);

  await done;

  assert.deepEqual(observed, [true, true], 'no new entry may start while the position may be unprotected');
  assert.deepEqual(venue.calls, [
    'placeLegs:1', 'cancelAllOpen', 'flatten:LONG:1',
    'placeLegs:1', 'cancelAllOpen', 'flatten:LONG:1',
  ]);
  assert.equal(venue.tracker.busy, false);
});

test('a failed venue read is retried and does not change the entry state', async () => {
  const venue = new FakeVenue();
  venue.readFailures = 1;
  venue.script = [(v) => { v.status = 'FILLED'; v.executedQty = 1; v.held = 1; }];
  const { done, logs } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['placeLegs:1', 'recordEntry:100']);
  assert.match(logs.join('\n'), /venue call failed, retrying: read timed out/);
});

test('legs that the position no longer needs are cancelled once it is flat, and the entry does not resolve before that', async () => {
  const venue = new FakeVenue();
  venue.script = [
    (v) => { v.status = 'PARTIALLY_FILLED'; v.executedQty = 0.4; v.held = 0.4; },
    (v) => { v.held = 0; },
  ];
  const { done } = run(venue);

  await done;

  assert.deepEqual(venue.calls, ['placeLegs:0.4', 'recordEntry:100', 'cancelLegs:100', 'cancelOrder']);
});

test('legs that cannot be cancelled keep the entry unresolved until they are gone', async () => {
  const venue = new FakeVenue();
  venue.cancelLegsFailures = 1;
  venue.script = [
    (v) => { v.status = 'PARTIALLY_FILLED'; v.executedQty = 0.4; v.held = 0.4; },
    (v) => { v.status = 'FILLED'; v.executedQty = 1; v.held = 1; },
  ];
  const { done, logs } = run(venue);

  await done;

  assert.deepEqual(venue.calls, [
    'placeLegs:0.4', 'recordEntry:100', 'placeLegs:1', 'recordEntry:102', 'cancelLegs:100', 'cancelLegs:100',
  ]);
  assert.match(logs.join('\n'), /could not cancel superseded protective legs, retrying/);
});

test('while an entry works, a second entry is refused; a reservation that was never submitted can be released', () => {
  const venue = new FakeVenue();
  const tracker = new LiveEntryTracker(venue, { ttlMs: TTL, pollMs: POLL, log: () => undefined, sleep: () => new Promise(() => undefined) });

  tracker.reserve('SOLUSDT');
  assert.equal(tracker.busy, true);
  assert.throws(() => tracker.reserve('ETHUSDT'), OrderInFlightError);
  tracker.release('SOLUSDT');
  assert.equal(tracker.busy, false);

  void tracker.track(JOB);
  assert.equal(tracker.busy, true);
  assert.throws(() => tracker.reserve('ETHUSDT'), OrderInFlightError);
  tracker.release('SOLUSDT');
  assert.equal(tracker.busy, true, 'a submitted entry is released only when it resolves');
});

test('only statuses that can still change count as working; an unknown status counts as working', () => {
  for (const status of ['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL', 'SOME_NEW_STATUS']) assert.equal(isWorking(status), true, status);
  for (const status of ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED', 'UNKNOWN_ORDER']) assert.equal(isWorking(status), false, status);
});

test('a submit whose answer was lost resolves once the venue reports the order unknown: nothing was placed, nothing is protected', async () => {
  const venue = new FakeVenue();
  venue.status = 'UNKNOWN_ORDER';
  const { done, logs } = run(venue);

  await done;

  assert.deepEqual(venue.calls, []);
  assert.equal(venue.tracker.busy, false);
  assert.match(logs.join('\n'), /UNKNOWN_ORDER: executed 0, no position/);
});

test('only an answer carrying a Binance code counts as a refusal; a timeout or dropped connection does not', () => {
  assert.equal(venueRejected({ code: -2019, message: 'Margin is insufficient.' }), true);
  assert.equal(venueRejected(new Error('socket hang up')), false);
  assert.equal(venueRejected({ message: 'no code' }), false);
  assert.equal(venueRejected(undefined), false);
});

test('client order ids fit the 36-character limit and do not collide within one millisecond', () => {
  const a = liveEntryClientOrderId(1_700_000_000_000);
  const b = liveEntryClientOrderId(1_700_000_000_000);
  assert.ok(a.length <= 36 && b.length <= 36, `${a} / ${b}`);
  assert.match(a, /^[A-Za-z0-9]+$/);
  assert.notEqual(a, b);
});

test('entry sides map to the Binance order side that opens them', () => {
  assert.equal(orderSideOf('LONG'), 'BUY');
  assert.equal(orderSideOf('SHORT'), 'SELL');
});
