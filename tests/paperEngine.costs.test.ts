import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PaperEngine, type PaperCosts } from '../src/binance/paperEngine.js';

const base = { symbol: 'BTCUSDT', leverage: 5, strategy: 'MOMENTUM-γ' as const };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const HOUR = 60 * 60 * 1000;
const SLOT = 8 * HOUR;
const stateFile = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'paper-costs-')), 'state.json');

interface Clock { t: number }
const engineWith = (costs: PaperCosts, clock: Clock = { t: Date.now() }, file = stateFile()): PaperEngine =>
  new PaperEngine(file, costs, () => clock.t);

const FEE_ONLY: PaperCosts = { takerFeeRate: 0.001, slippageRate: 0 };
const SLIPPAGE_ONLY: PaperCosts = { takerFeeRate: 0, slippageRate: 0.01 };
const NO_COSTS: PaperCosts = { takerFeeRate: 0, slippageRate: 0 };
const RATE = { BTCUSDT: 0.0001 };

test('a long pays the taker fee on its entry and on its exit, and the journal PnL is net of both', () => {
  const engine = engineWith(FEE_ONLY);
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, reduceOnly: true, entryPrice: 110 });
  // gross 10, minus 0.1 on the entry notional and 0.11 on the exit notional
  near(engine.getTrades()[0].pnl, 10 - 0.1 - 0.11);
});

test('slippage moves each fill against the trader, for a long and for a short', () => {
  const long = engineWith(SLIPPAGE_ONLY);
  long.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  long.openPosition({ ...base, side: 'SELL', qty: 1, reduceOnly: true, entryPrice: 110 });
  assert.deepEqual([long.getTrades()[0].entry, long.getTrades()[0].exit].map((p) => Math.round(p * 1e6) / 1e6), [101, 108.9]);
  near(long.getTrades()[0].pnl, 7.9);

  const short = engineWith(SLIPPAGE_ONLY);
  short.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 100 });
  short.openPosition({ ...base, side: 'BUY', qty: 1, reduceOnly: true, entryPrice: 90 });
  assert.deepEqual([short.getTrades()[0].entry, short.getTrades()[0].exit].map((p) => Math.round(p * 1e6) / 1e6), [99, 90.9]);
  near(short.getTrades()[0].pnl, 8.1);
});

test('a long pays a positive funding rate at each 8-hour boundary it is held through, and a short receives it', () => {
  const longClock = { t: 5 * SLOT + 500 };
  const longs = engineWith(NO_COSTS, longClock);
  longs.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  longs.accrueFunding(RATE, 5 * SLOT + 1_000);
  longs.accrueFunding(RATE, 6 * SLOT + 1_000);
  near(longs.getPositions()[0].upnl, -0.02);

  const shortClock = { t: 5 * SLOT + 500 };
  const shorts = engineWith(NO_COSTS, shortClock);
  shorts.openPosition({ ...base, side: 'SELL', qty: 2, entryPrice: 100 });
  shorts.accrueFunding(RATE, 5 * SLOT + 1_000);
  shorts.accrueFunding(RATE, 6 * SLOT + 1_000);
  near(shorts.getPositions()[0].upnl, 0.02);
});

test('funding is charged once per boundary, not once per call inside the same 8-hour slot', () => {
  const clock = { t: 5 * SLOT + 500 };
  const engine = engineWith(NO_COSTS, clock);
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  engine.accrueFunding(RATE, 5 * SLOT + 1_000);
  engine.accrueFunding(RATE, 5 * SLOT + 2 * HOUR);
  engine.accrueFunding(RATE, 5 * SLOT + 7 * HOUR);
  assert.equal(engine.getPositions()[0].upnl, 0, 'no boundary has been crossed yet');
  engine.accrueFunding(RATE, 6 * SLOT + 1_000);
  near(engine.getPositions()[0].upnl, -0.02);
});

test('the first accrual only sets the clock, so a boundary that passed before the engine saw the position is not charged', () => {
  const clock = { t: 5 * SLOT + 500 };
  const engine = engineWith(NO_COSTS, clock);
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  engine.accrueFunding(RATE, 6 * SLOT + 1_000);
  assert.equal(engine.getPositions()[0].upnl, 0);
});

test('a boundary at or before the open time is not charged to the position, even when the first accrual comes late', () => {
  const clock = { t: 4 * SLOT + 1_000 };
  const engine = engineWith(NO_COSTS, clock);
  engine.accrueFunding(RATE, 4 * SLOT + 1_000);
  clock.t = 5 * SLOT + 500;
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  engine.accrueFunding(RATE, 5 * SLOT + 1_000);
  assert.equal(engine.getPositions()[0].upnl, 0, 'the 5 boundary was before the open');
  engine.accrueFunding(RATE, 6 * SLOT + 1_000);
  near(engine.getPositions()[0].upnl, -0.02);
});

test('several boundaries crossed in one call are each charged at the current rate', () => {
  const clock = { t: 4 * SLOT + 500 };
  const engine = engineWith(NO_COSTS, clock);
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.accrueFunding(RATE, 4 * SLOT + 1_000);
  engine.accrueFunding(RATE, 7 * SLOT + 1_000);
  near(engine.getPositions()[0].upnl, -0.03);
});

test('funding accrued before a close is carried into that close\'s PnL', () => {
  const clock = { t: 5 * SLOT + 500 };
  const engine = engineWith(NO_COSTS, clock);
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.accrueFunding(RATE, 5 * SLOT + 1_000);
  engine.accrueFunding(RATE, 6 * SLOT + 1_000);
  engine.openPosition({ ...base, side: 'SELL', qty: 1, reduceOnly: true, entryPrice: 110 });
  near(engine.getTrades()[0].pnl, 10 - 0.01);
});

test('the funding clock and the charges survive a restart, so each boundary is charged once across restarts', async () => {
  const file = stateFile();
  const clock = { t: 5 * SLOT + 500 };
  const before = engineWith(NO_COSTS, clock, file);
  before.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  before.accrueFunding(RATE, 5 * SLOT + 1_000);
  before.accrueFunding(RATE, 6 * SLOT + 1_000);
  await new Promise((resolve) => setTimeout(resolve, 300)); // the book saves on a 250 ms debounce

  const after = engineWith(NO_COSTS, clock, file);
  near(after.getPositions()[0].upnl, -0.02);
  after.accrueFunding(RATE, 6 * SLOT + 2 * HOUR);
  near(after.getPositions()[0].upnl, -0.02);
  after.accrueFunding(RATE, 7 * SLOT + 1_000);
  near(after.getPositions()[0].upnl, -0.04);
});

test('a partial close carries its share of the open fee, and the remainder keeps the rest', () => {
  const engine = engineWith(FEE_ONLY);
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, reduceOnly: true, entryPrice: 110, exitReason: 'PARTIAL TP' });
  // closed half: gross 10, half of the 0.2 open fee, and 0.11 on its exit
  near(engine.getTrades()[0].pnl, 10 - 0.1 - 0.11);
  // remaining half: gross 10 at the new mark, less the other 0.1 of the open fee
  engine.markAll({ BTCUSDT: 110 });
  near(engine.getPositions()[0].upnl, 10 - 0.1);
});

test('a position opened and closed at the same price loses exactly the fees and slippage', () => {
  const engine = engineWith({ takerFeeRate: 0.0004, slippageRate: 0.0002 });
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, reduceOnly: true, entryPrice: 100 });
  const entry = 100 * 1.0002;
  const exit = 100 * (1 - 0.0002);
  near(engine.getTrades()[0].pnl, (exit - entry) - entry * 0.0004 - exit * 0.0004);
  assert.ok(engine.getTrades()[0].pnl < 0);
});
