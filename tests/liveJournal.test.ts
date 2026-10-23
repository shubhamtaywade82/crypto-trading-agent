import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  closedTradesFromFills, LiveJournal, LiveOwners, type FillView, type FundingView, type JournalSource,
} from '../src/binance/liveJournal.js';

const owner = () => 'MOMENTUM-γ' as const;
const fill = (over: Partial<FillView>): FillView => ({
  id: 1, symbol: 'ETHUSDT', orderId: 1, side: 'SELL', price: 110, qty: 1, realizedPnl: 0, commission: 0, commissionAsset: 'USDT', time: 1_000, ...over,
});

test('a sell that realizes PnL closes a long, and the entry is recovered from the venue\'s own realized figure', () => {
  const { trades } = closedTradesFromFills([fill({ qty: 2, price: 110, realizedPnl: 20, commission: 0.2 })], [], owner);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, 'LONG');
  assert.ok(Math.abs(trades[0].entry - 100) < 1e-9);
  assert.ok(Math.abs(trades[0].pnl - 19.8) < 1e-9);
});

test('a buy that realizes PnL closes a short', () => {
  const { trades } = closedTradesFromFills([fill({ side: 'BUY', price: 90, realizedPnl: 10, commission: 0.1 })], [], owner);
  assert.equal(trades[0].side, 'SHORT');
  assert.ok(Math.abs(trades[0].entry - 100) < 1e-9);
  assert.ok(Math.abs(trades[0].pnl - 9.9) < 1e-9);
});

test('executions of one order aggregate into one trade with a weighted exit and entry', () => {
  const { trades } = closedTradesFromFills([
    fill({ id: 1, price: 110, qty: 1, realizedPnl: 5, time: 1_000 }),
    fill({ id: 2, price: 112, qty: 1, realizedPnl: 7, time: 1_001 }),
  ], [], owner);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].qty, 2);
  assert.ok(Math.abs(trades[0].exit - 111) < 1e-9);
  assert.ok(Math.abs(trades[0].entry - 105) < 1e-9);
  assert.ok(Math.abs(trades[0].pnl - 12) < 1e-9);
});

test('an opening execution\'s commission is charged to the next close, so no fee is dropped', () => {
  const { trades } = closedTradesFromFills([
    fill({ id: 1, side: 'BUY', orderId: 5, price: 100, qty: 1, realizedPnl: 0, commission: 0.5, time: 500 }),
    fill({ id: 2, side: 'SELL', orderId: 6, price: 110, qty: 1, realizedPnl: 10, commission: 0.1, time: 1_000 }),
  ], [], owner);
  assert.ok(Math.abs(trades[0].pnl - (10 - 0.1 - 0.5)) < 1e-9);
});

test('funding paid while holding is charged to the close of that symbol', () => {
  const funding: FundingView[] = [{ symbol: 'ETHUSDT', amount: -0.3, time: 800 }];
  const { trades } = closedTradesFromFills([fill({ realizedPnl: 10 })], funding, owner);
  assert.ok(Math.abs(trades[0].pnl - 9.7) < 1e-9);
});

test('total journal PnL equals realized minus commissions plus funding, across trades and symbols', () => {
  const fills = [
    fill({ id: 1, side: 'BUY', orderId: 1, realizedPnl: 0, commission: 0.4, time: 100 }),
    fill({ id: 2, side: 'SELL', orderId: 2, realizedPnl: 8, commission: 0.2, time: 200 }),
    fill({ id: 3, symbol: 'SOLUSDT', side: 'SELL', orderId: 3, realizedPnl: -3, commission: 0.1, time: 300 }),
  ];
  const funding: FundingView[] = [{ symbol: 'ETHUSDT', amount: 0.25, time: 150 }];
  const { trades } = closedTradesFromFills(fills, funding, owner);
  const total = trades.reduce((sum, t) => sum + t.pnl, 0);
  assert.ok(Math.abs(total - (8 - 0.2 - 0.4 - 0.1 - 3 + 0.25)) < 1e-9, `total ${total}`);
});

test('commissions in an asset other than USDT are not converted, and are reported', () => {
  const built = closedTradesFromFills([fill({ realizedPnl: 10, commission: 0.001, commissionAsset: 'BNB' })], [], owner);
  assert.ok(Math.abs(built.trades[0].pnl - 10) < 1e-9);
  assert.ok(Math.abs(built.unpricedFees - 0.001) < 1e-12);
});

test('the owner of a close is the strategy that owned the symbol when it closed', () => {
  const lookup = (symbol: string, at: number) => (symbol === 'ETHUSDT' && at >= 500 ? 'STRUCT-LIQ-η' as const : 'MOMENTUM-γ' as const);
  const { trades } = closedTradesFromFills([fill({ realizedPnl: 10, time: 900 })], [], lookup);
  assert.equal(trades[0].strategy, 'STRUCT-LIQ-η');
});

const tempDir = (): string => mkdtempSync(path.join(tmpdir(), 'journal-'));

function fakeSource(pages: Record<string, FillView[][]>, requests: Array<{ symbol: string; fromId: number | undefined }> = []): JournalSource {
  const next: Record<string, number> = {};
  return {
    accountTrades: async (symbol, fromId) => {
      requests.push({ symbol, fromId });
      const i = next[symbol] ?? 0;
      next[symbol] = i + 1;
      return pages[symbol]?.[i] ?? [];
    },
    fundingFees: async () => [],
  };
}

test('a sync journals the closes, persists them, and a new instance resumes from the same state', async () => {
  const file = path.join(tempDir(), 'journal.json');
  let clock = 10_000;
  const journal = new LiveJournal(file, () => clock);
  await journal.sync(fakeSource({ ETHUSDT: [[fill({ id: 7, realizedPnl: 4 })]] }), ['ETHUSDT'], owner);
  assert.equal(journal.trades().length, 1);
  assert.equal(new LiveJournal(file, () => clock).trades().length, 1);
  assert.equal(new LiveJournal(file, () => clock).isFresh(60_000), true);
});

test('the journal is not fresh until a sync succeeds, and goes stale after the window', async () => {
  const file = path.join(tempDir(), 'journal.json');
  let clock = 1_000;
  const journal = new LiveJournal(file, () => clock);
  assert.equal(journal.isFresh(60_000), false, 'never synced must block entries');
  await journal.sync(fakeSource({}), ['ETHUSDT'], owner);
  assert.equal(journal.isFresh(60_000), true);
  clock = 62_000;
  assert.equal(journal.isFresh(60_000), false, 'an old sync must stop counting');
});

test('a failed sync leaves the journal as it was and not fresh', async () => {
  const file = path.join(tempDir(), 'journal.json');
  const journal = new LiveJournal(file, () => 5);
  await journal.sync(fakeSource({ ETHUSDT: [[fill({ id: 1, realizedPnl: 4 })]] }), ['ETHUSDT'], owner);
  const failing: JournalSource = {
    accountTrades: async () => { throw new Error('venue down'); },
    fundingFees: async () => [],
  };
  await assert.rejects(journal.sync(failing, ['ETHUSDT'], owner), /venue down/);
  assert.equal(journal.trades().length, 1);
});

test('a full page is followed by the next page from the last trade id, and the cursor then resumes after it', async () => {
  const file = path.join(tempDir(), 'journal.json');
  const requests: Array<{ symbol: string; fromId: number | undefined }> = [];
  const first = Array.from({ length: 1000 }, (_, i) => fill({ id: i + 1, orderId: i + 1, realizedPnl: 0 }));
  const journal = new LiveJournal(file, () => 1);
  await journal.sync(fakeSource({ ETHUSDT: [first, [fill({ id: 1001, orderId: 1001, realizedPnl: 0 })]] }, requests), ['ETHUSDT'], owner);
  assert.deepEqual(requests.map((r) => r.fromId), [undefined, 1001]);
  requests.length = 0;
  await journal.sync(fakeSource({}, requests), ['ETHUSDT'], owner);
  assert.deepEqual(requests.map((r) => r.fromId), [1002]);
});

test('a corrupt journal file reads as empty and not fresh, so entries stay blocked until a sync', () => {
  const file = path.join(tempDir(), 'journal.json');
  writeFileSync(file, '{broken');
  const journal = new LiveJournal(file, () => 1);
  assert.equal(journal.trades().length, 0);
  assert.equal(journal.isFresh(60_000), false);
});

test('owners resolve to the latest entry on the symbol before the time, defaulting to the executor', () => {
  const file = path.join(tempDir(), 'owners.json');
  const owners = new LiveOwners(file);
  owners.record({ symbol: 'ETHUSDT', side: 'LONG', strategy: 'MOMENTUM-γ', submittedAt: 100, clientOrderId: 'e1' });
  owners.record({ symbol: 'ETHUSDT', side: 'LONG', strategy: 'STRUCT-LIQ-η', submittedAt: 300, clientOrderId: 'e2' });
  assert.equal(owners.ownerAt('ETHUSDT', 50), 'EXECUTOR-ε');
  assert.equal(owners.ownerAt('ETHUSDT', 200), 'MOMENTUM-γ');
  assert.equal(owners.ownerAt('ETHUSDT', 400), 'STRUCT-LIQ-η');
  assert.equal(new LiveOwners(file).ownerAt('ETHUSDT', 400), 'STRUCT-LIQ-η', 'owners survive a restart');
  assert.ok(readFileSync(file, 'utf-8').includes('e2'));
});
