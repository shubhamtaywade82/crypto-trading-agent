import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rMultipleOf, summarizeTradePlans, TradePlanLedger, type AnnounceInput } from '../src/ops/tradePlans.js';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const tempPath = (name = 'trade-plans.jsonl') => join(mkdtempSync(join(tmpdir(), 'plans-')), name);

const LONG: AnnounceInput = {
  planId: 'p1', source: 'SIGNAL', symbol: 'BTCUSDT', side: 'LONG', strategy: 'MOMENTUM', at: T0,
  planned: { entry: 100, stopLoss: 98, takeProfit: 106 },
};

test('announce opens a plan in ANNOUNCED with no delivery recorded yet', () => {
  const ledger = new TradePlanLedger(null);
  const result = ledger.announce(LONG);
  assert.equal(result.applied, true);
  const plan = ledger.get('p1');
  assert.equal(plan?.status, 'ANNOUNCED');
  assert.equal(plan?.announceNotify, 'NOT_ATTEMPTED');
  assert.equal(plan?.closeNotify, 'NOT_ATTEMPTED');
  assert.equal(plan?.result, null);
});

test('a duplicate planId and levels on the wrong side of the entry are refused', () => {
  const ledger = new TradePlanLedger(null);
  assert.equal(ledger.announce(LONG).applied, true);
  assert.equal(ledger.announce(LONG).applied, false, 'duplicate must not overwrite the original plan');
  const inverted = ledger.announce({ ...LONG, planId: 'p2', planned: { entry: 100, stopLoss: 104, takeProfit: 106 } });
  assert.equal(inverted.applied, false);
  const nan = ledger.announce({ ...LONG, planId: 'p3', planned: { entry: 100, stopLoss: NaN, takeProfit: 106 } });
  assert.equal(nan.applied, false);
  assert.equal(ledger.get('p2'), undefined);
  assert.equal(ledger.get('p3'), undefined);
});

test('a LONG that hits its target closes with TP and an R multiple measured against the planned stop', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce(LONG);
  ledger.fill('p1', T0 + 1_000);
  const closed = ledger.close('p1', { at: T0 + 60_000, result: 'TP', exitPrice: 106, entryPrice: 100.4, pnl: 42 });
  assert.equal(closed.applied, true);
  const plan = ledger.get('p1');
  assert.equal(plan?.status, 'CLOSED');
  assert.equal(plan?.result, 'TP');
  assert.equal(plan?.entryPrice, 100.4);
  assert.equal(plan?.pnl, 42);
  // (106 - 100.4) / |100 - 98| = 2.8
  assert.ok(Math.abs((plan?.rMultiple ?? NaN) - 2.8) < 1e-9);
});

test('a SHORT that is stopped out closes with SL and a negative R multiple of -1 at the planned stop', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce({ ...LONG, planId: 's1', side: 'SHORT', planned: { entry: 100, stopLoss: 102, takeProfit: 96 } });
  ledger.fill('s1', T0);
  ledger.close('s1', { at: T0 + 1, result: 'SL', exitPrice: 102, entryPrice: 100, pnl: -20 });
  assert.equal(ledger.get('s1')?.rMultiple, -1);
  assert.equal(ledger.get('s1')?.result, 'SL');
});

test('rMultipleOf is null when the planned risk is zero or a price is missing', () => {
  assert.equal(rMultipleOf('LONG', { entry: 100, stopLoss: 100, takeProfit: 110 }, 100, 110), null);
  assert.equal(rMultipleOf('LONG', { entry: 100, stopLoss: 98, takeProfit: 106 }, NaN, 106), null);
  assert.equal(rMultipleOf('SHORT', { entry: 100, stopLoss: 102, takeProfit: 96 }, 100, 96), 2);
});

test('close is refused once the plan is terminal, and fill is refused unless ANNOUNCED', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce(LONG);
  ledger.fill('p1', T0);
  assert.equal(ledger.fill('p1', T0 + 1).applied, false, 'a second fill is a replay');
  ledger.close('p1', { at: T0 + 2, result: 'SL', exitPrice: 98, pnl: -10 });
  const again = ledger.close('p1', { at: T0 + 3, result: 'TP', exitPrice: 106, pnl: 10 });
  assert.equal(again.applied, false);
  assert.equal(ledger.get('p1')?.result, 'SL', 'the first recorded outcome stands');
});

test('a close may arrive from ANNOUNCED when the venue filled a resting limit without a fill event reaching us', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce(LONG);
  const closed = ledger.close('p1', { at: T0 + 5, result: 'TP', exitPrice: 106, entryPrice: 100.1, pnl: 30 });
  assert.equal(closed.applied, true);
  assert.equal(ledger.get('p1')?.filledAt, null, 'the fill time is unknown and must not be invented');
  assert.equal(ledger.get('p1')?.entryPrice, 100.1);
});

test('notFilled is terminal and carries the reason', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce(LONG);
  assert.equal(ledger.notFilled('p1', T0 + 1, 'IOC limit cancelled').applied, true);
  assert.equal(ledger.get('p1')?.status, 'NOT_FILLED');
  assert.equal(ledger.get('p1')?.note, 'IOC limit cancelled');
  assert.equal(ledger.fill('p1', T0 + 2).applied, false);
});

test('a partial take-profit is recorded and the plan stays open; a replayed partial is not duplicated', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce(LONG);
  ledger.fill('p1', T0);
  ledger.partial('p1', { at: T0 + 10, exitPrice: 104, pnl: 12 });
  ledger.partial('p1', { at: T0 + 10, exitPrice: 104, pnl: 12 });
  const plan = ledger.get('p1');
  assert.equal(plan?.status, 'FILLED');
  assert.equal(plan?.partials.length, 1);
  assert.equal(ledger.close('p1', { at: T0 + 20, result: 'TP', exitPrice: 106, pnl: 30 }).applied, true);
});

test('notify records delivery for the announce and close slots independently', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce(LONG);
  ledger.notify('p1', 'announce', 'SENT', T0);
  ledger.fill('p1', T0);
  ledger.close('p1', { at: T0 + 1, result: 'SL', exitPrice: 98, pnl: -10 });
  ledger.notify('p1', 'close', 'FAILED', T0 + 2);
  assert.equal(ledger.get('p1')?.announceNotify, 'SENT');
  assert.equal(ledger.get('p1')?.closeNotify, 'FAILED');
  assert.equal(ledger.notify('nope', 'announce', 'SENT', T0).applied, false);
});

test('openFor returns the unresolved plans of one source and symbol, newest first', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce({ ...LONG, planId: 'old', at: T0 });
  ledger.announce({ ...LONG, planId: 'new', at: T0 + 1000 });
  ledger.announce({ ...LONG, planId: 'other-symbol', symbol: 'ETHUSDT', at: T0 + 2000 });
  ledger.announce({ ...LONG, planId: 'fleet', source: 'FLEET', at: T0 + 3000 });
  ledger.close('old', { at: T0 + 1, result: 'TP', exitPrice: 106, pnl: 1 });
  assert.deepEqual(ledger.openFor('SIGNAL', 'BTCUSDT').map((p) => p.planId), ['new']);
});

test('plans survive a restart: a new ledger on the same file replays to the same state, last snapshot wins', () => {
  const file = tempPath();
  const first = new TradePlanLedger(file);
  first.announce(LONG);
  first.notify('p1', 'announce', 'SENT', T0);
  first.fill('p1', T0);
  first.close('p1', { at: T0 + 60_000, result: 'TP', exitPrice: 106, entryPrice: 100, pnl: 60 });

  const second = new TradePlanLedger(file);
  const plan = second.get('p1');
  assert.equal(plan?.status, 'CLOSED');
  assert.equal(plan?.result, 'TP');
  assert.equal(plan?.announceNotify, 'SENT');
  assert.equal(plan?.pnl, 60);
  assert.ok(Math.abs((plan?.rMultiple ?? NaN) - 3) < 1e-9);
});

test('a torn last line from a crash is skipped, and the next row starts on a fresh line', () => {
  const file = tempPath();
  const writer = new TradePlanLedger(file);
  writer.announce(LONG);
  appendFileSync(file, '{"planId":"p2","status":"FILL');

  const reloaded = new TradePlanLedger(file);
  assert.ok(reloaded.get('p1'));
  assert.equal(reloaded.get('p2'), undefined);
  reloaded.announce({ ...LONG, planId: 'p3' });

  const fresh = new TradePlanLedger(file);
  assert.ok(fresh.get('p3'), 'the row written after the torn line must still parse');
  assert.ok(fresh.get('p1'));
});

test('a failing disk never throws: the transition still applies in memory and lastError says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plans-blocked-'));
  writeFileSync(join(dir, 'blocker'), 'not a directory');
  const ledger = new TradePlanLedger(join(dir, 'blocker', 'trade-plans.jsonl'));
  assert.doesNotThrow(() => ledger.announce(LONG));
  assert.equal(ledger.get('p1')?.status, 'ANNOUNCED');
  assert.ok(ledger.lastError, 'a failed append must be visible to the operator');
});

test('every transition leaves a full snapshot row on disk', () => {
  const file = tempPath();
  mkdirSync(join(file, '..'), { recursive: true });
  const ledger = new TradePlanLedger(file);
  ledger.announce(LONG);
  ledger.fill('p1', T0);
  const rows = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'ANNOUNCED');
  assert.equal(rows[1].status, 'FILLED');
});

test('the summary counts outcomes, leaves UNOBSERVED out of the win rate, and flags failed cards', () => {
  const ledger = new TradePlanLedger(null);
  ledger.announce({ ...LONG, planId: 'win' });
  ledger.fill('win', T0);
  ledger.close('win', { at: T0 + 1, result: 'TP', exitPrice: 106, pnl: 30 });
  ledger.announce({ ...LONG, planId: 'loss' });
  ledger.fill('loss', T0);
  ledger.close('loss', { at: T0 + 1, result: 'SL', exitPrice: 98, pnl: -10 });
  ledger.announce({ ...LONG, planId: 'gone' });
  ledger.fill('gone', T0);
  ledger.close('gone', { at: T0 + 1, result: 'UNOBSERVED', exitPrice: null, pnl: null });
  ledger.announce({ ...LONG, planId: 'refused' });
  ledger.notFilled('refused', T0, 'capacity');
  ledger.announce({ ...LONG, planId: 'open' });
  ledger.notify('open', 'announce', 'FAILED', T0);

  const s = summarizeTradePlans(ledger.all());
  assert.equal(s.total, 5);
  assert.equal(s.open, 1);
  assert.equal(s.closed, 2);
  assert.equal(s.unobserved, 1);
  assert.equal(s.notFilled, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.totalPnl, 20);
  assert.equal(s.cardsFailed, 1);
  assert.equal(s.meanR, (3 + -1) / 2);
});

test('the summary of nothing has no win rate and no mean R, rather than zero', () => {
  const s = summarizeTradePlans([]);
  assert.equal(s.winRate, null);
  assert.equal(s.meanR, null);
  assert.equal(s.total, 0);
});

test('a bloated ledger is compacted at startup to one snapshot per plan, and its state survives', () => {
  const file = tempPath();
  const first = new TradePlanLedger(file);
  first.announce(LONG);
  first.fill('p1', T0);
  for (let i = 0; i < 6_000; i += 1) first.notify('p1', 'announce', i % 2 === 0 ? 'SENT' : 'FAILED', T0 + i);
  first.notify('p1', 'announce', 'SENT', T0 + 6_001);
  assert.ok(readFileSync(file, 'utf-8').trim().split('\n').length > 6_000, 'the file grew with every transition');

  const reloaded = new TradePlanLedger(file);
  assert.equal(readFileSync(file, 'utf-8').trim().split('\n').length, 1, 'compacted to one snapshot per plan');
  assert.equal(reloaded.get('p1')?.status, 'FILLED');
  assert.equal(reloaded.get('p1')?.announceNotify, 'SENT');
  assert.equal(reloaded.lastError, undefined);
});

test('a small ledger is never rewritten at startup', () => {
  const file = tempPath();
  const ledger = new TradePlanLedger(file);
  for (let i = 0; i < 10; i += 1) ledger.notify('p1', 'announce', 'SENT', T0 + i);
  ledger.announce(LONG);
  const before = readFileSync(file, 'utf-8');
  new TradePlanLedger(file);
  assert.equal(readFileSync(file, 'utf-8'), before);
});
