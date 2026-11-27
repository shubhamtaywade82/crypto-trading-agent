import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { advanceCall, BriefCallLedger, callLevelsOf, CALL_HORIZON_MS, summarizeCalls, type BriefCall } from '../src/marketBrief/BriefCalls.js';
import type { MarketBrief } from '../src/marketBrief/types.js';

const T0 = 1_800_000_000_000;

/** support [99, 100], resistance [110, 111]: a long enters at 100, stops at 99, targets 110 */
const brief = (over: { action?: string; support?: [number, number] | null; resistance?: [number, number] | null; mark?: number | null; at?: number; symbol?: string } = {}): MarketBrief =>
  ({
    briefId: `b-${over.at ?? T0}`,
    symbol: over.symbol ?? 'SOLUSDT',
    generatedAt: over.at ?? T0,
    decision: { action: over.action ?? 'BUY_LONG' },
    levels: {
      support: over.support === undefined ? [99, 100] : over.support,
      resistance: over.resistance === undefined ? [110, 111] : over.resistance,
      equilibrium: null,
    },
    market: { markPrice: over.mark === undefined ? 105 : over.mark, lastPrice: over.mark === undefined ? 105 : over.mark },
  }) as unknown as MarketBrief;

const callOf = (over: Partial<BriefCall> = {}): BriefCall => ({
  callId: 'c', briefId: 'b', symbol: 'SOLUSDT', direction: 'LONG', openedAt: T0, expiresAt: T0 + CALL_HORIZON_MS,
  entry: 100, stop: 99, target: 110, filledAt: null, status: 'OPEN', resolvedAt: null, exitPrice: null, rMultiple: null,
  lastMark: null, lastMarkAt: null, ...over,
});

// ---- levels ----

test('a BUY_LONG enters at support\'s upper edge, stops below its lower edge and targets resistance\'s lower edge', () => {
  assert.deepEqual(callLevelsOf(brief()), { direction: 'LONG', entry: 100, stop: 99, target: 110 });
});

test('a SELL_SHORT is the mirror: enters at resistance\'s lower edge, stops above its upper edge, targets support\'s upper edge', () => {
  assert.deepEqual(
    callLevelsOf(brief({ action: 'SELL_SHORT', support: [99, 100], resistance: [110, 111] })),
    { direction: 'SHORT', entry: 110, stop: 111, target: 100 },
  );
});

test('a missing band, a NO_TRADE action, or bands that do not form a valid trade give no call', () => {
  assert.equal(callLevelsOf(brief({ support: null })), null);
  assert.equal(callLevelsOf(brief({ resistance: null })), null);
  assert.equal(callLevelsOf(brief({ action: 'NO_TRADE' })), null);
  assert.equal(callLevelsOf(brief({ support: [99, 112] })), null, 'entry above target is not a long');
});

// ---- state machine ----

test('a long fills when the mark reaches the entry, not before', () => {
  const open = callOf();
  assert.equal(advanceCall(open, 101, T0 + 1).filledAt, null);
  assert.equal(advanceCall(open, 100, T0 + 2).filledAt, T0 + 2);
});

test('after the fill, reaching the target resolves TP at the target, with an R multiple of +10', () => {
  const filled = callOf({ filledAt: T0 + 1 });
  const done = advanceCall(filled, 110, T0 + 3);
  assert.equal(done.status, 'TP');
  assert.equal(done.exitPrice, 110);
  assert.equal(done.rMultiple, 10, '(110 - 100) / (100 - 99)');
});

test('after the fill, reaching the stop resolves SL at the stop, with an R multiple of -1', () => {
  const done = advanceCall(callOf({ filledAt: T0 + 1 }), 98.5, T0 + 3);
  assert.equal(done.status, 'SL');
  assert.equal(done.exitPrice, 99);
  assert.equal(done.rMultiple, -1);
});

test('a filled call that is neither stopped nor at target expires with the last mark', () => {
  const done = advanceCall(callOf({ filledAt: T0 + 1 }), 104, T0 + CALL_HORIZON_MS);
  assert.equal(done.status, 'EXPIRED');
  assert.equal(done.exitPrice, 104);
  assert.equal(done.rMultiple, 4);
});

test('a call never filled by its horizon is NOT_FILLED, with no R', () => {
  const done = advanceCall(callOf(), 105, T0 + CALL_HORIZON_MS);
  assert.equal(done.status, 'NOT_FILLED');
  assert.equal(done.rMultiple, null);
});

test('a resolved call ignores later observations', () => {
  const done = advanceCall(callOf({ filledAt: T0 + 1 }), 110, T0 + 3);
  assert.equal(advanceCall(done, 90, T0 + 4), done);
});

test('a short fills when the mark reaches its entry from below, and stops when it rises to the stop', () => {
  const short = callOf({ direction: 'SHORT', entry: 110, stop: 111, target: 100 });
  assert.equal(advanceCall(short, 109, T0 + 1).filledAt, null);
  assert.equal(advanceCall(short, 110, T0 + 2).filledAt, T0 + 2);
  const stopped = advanceCall(callOf({ direction: 'SHORT', entry: 110, stop: 111, target: 100, filledAt: T0 + 2 }), 111.5, T0 + 3);
  assert.equal(stopped.status, 'SL');
  assert.equal(stopped.rMultiple, -1);
});

// ---- summary ----

test('the summary counts each outcome, and its mean R covers only filled calls that resolved with an R', () => {
  const calls: BriefCall[] = [
    callOf({ callId: 'tp', filledAt: T0, status: 'TP', rMultiple: 10 }),
    callOf({ callId: 'sl', filledAt: T0, status: 'SL', rMultiple: -1 }),
    callOf({ callId: 'exp', filledAt: T0, status: 'EXPIRED', rMultiple: 4 }),
    callOf({ callId: 'nf', status: 'NOT_FILLED' }),
    callOf({ callId: 'open' }),
  ];
  const s = summarizeCalls(calls);
  assert.deepEqual(
    { total: s.total, open: s.open, filled: s.filled, tp: s.tp, sl: s.sl, expired: s.expired, notFilled: s.notFilled },
    { total: 5, open: 1, filled: 3, tp: 1, sl: 1, expired: 1, notFilled: 1 },
  );
  assert.equal(s.meanR, (10 - 1 + 4) / 3);
});

test('an empty set has no mean R', () => {
  assert.equal(summarizeCalls([]).meanR, null);
});

// ---- the ledger ----

test('an actionable brief opens one call, and a second brief while it is open does not open another', () => {
  const ledger = new BriefCallLedger(null);
  ledger.observe(brief({ mark: 105 }));
  ledger.observe(brief({ at: T0 + 300_000, mark: 105 }));
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.all()[0]!.expiresAt, T0 + CALL_HORIZON_MS);
});

test('a NO_TRADE brief opens nothing', () => {
  const ledger = new BriefCallLedger(null);
  ledger.observe(brief({ action: 'NO_TRADE' }));
  assert.equal(ledger.all().length, 0);
});

test('each later brief advances the open calls of its symbol, and resolves them through the state machine', () => {
  const ledger = new BriefCallLedger(null);
  ledger.observe(brief({ mark: 105 }));
  ledger.observe(brief({ at: T0 + 300_000, mark: 100 })); // fills
  ledger.observe(brief({ at: T0 + 600_000, mark: 110, action: 'NO_TRADE' })); // reaches the target
  const [call] = ledger.all();
  assert.equal(call!.status, 'TP');
  assert.equal(call!.filledAt, T0 + 300_000);
});

test('a brief without a mark does not advance any call', () => {
  const ledger = new BriefCallLedger(null);
  ledger.observe(brief({ mark: 105 }));
  ledger.observe(brief({ at: T0 + 300_000, mark: null, action: 'NO_TRADE' }));
  assert.equal(ledger.all()[0]!.status, 'OPEN');
});

test('calls survive a restart: a new ledger on the same file holds the same states', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'brief-calls-')), 'brief-calls.jsonl');
  const first = new BriefCallLedger(file);
  first.observe(brief({ mark: 105 }));
  first.observe(brief({ at: T0 + 300_000, mark: 100, action: 'NO_TRADE' }));
  const reloaded = new BriefCallLedger(file).all();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]!.filledAt, T0 + 300_000);
  assert.equal(reloaded[0]!.status, 'OPEN');
  assert.ok(readFileSync(file, 'utf-8').trim().split('\n').length >= 2, 'one row per change');
});

test('a torn last line from a crash is skipped on reload, and the valid rows still load', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'brief-calls-torn-')), 'brief-calls.jsonl');
  const first = new BriefCallLedger(file);
  first.observe(brief({ mark: 105 }));
  writeFileSync(file, `${JSON.stringify(first.all()[0])}\n{"callId":"torn`);
  const reloaded = new BriefCallLedger(file).all();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]!.status, 'OPEN');
});

test('a ledger with no file keeps calls in memory and reports no write error', () => {
  const ledger = new BriefCallLedger(null);
  ledger.observe(brief({ mark: 105 }));
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.lastError, undefined);
});

test('an unwritable file is recorded as lastError, never thrown, and the call is still held in memory', () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'brief-calls-blocked-')), 'not-a-directory');
  writeFileSync(blocker, '');
  const ledger = new BriefCallLedger(join(blocker, 'brief-calls.jsonl'));
  assert.doesNotThrow(() => ledger.observe(brief({ mark: 105 })));
  assert.equal(ledger.all().length, 1);
  assert.match(ledger.lastError ?? '', /EEXIST|ENOTDIR|file already exists|not a directory/i);
});
