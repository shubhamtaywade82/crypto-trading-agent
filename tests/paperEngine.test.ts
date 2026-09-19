import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PaperEngine } from '../src/binance/paperEngine.js';

const base = { symbol: 'BTCUSDT', leverage: 5, strategy: 'MOMENTUM-γ' as const };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

// Each engine persists to its own temp file so tests never touch data/paper-state.json
function freshEngine(): PaperEngine {
  return new PaperEngine(path.join(mkdtempSync(path.join(tmpdir(), 'paper-')), 'state.json'));
}

test('should merge same-side fills into one position with weighted-average entry', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100, stopLoss: 90, takeProfit: 130 });
  engine.openPosition({ ...base, side: 'BUY', qty: 3, entryPrice: 120, stopLoss: 105 });
  const [pos] = engine.getPositions();
  assert.equal(engine.getPositions().length, 1);
  near(pos.entry, 115);
  near(pos.qty, 4);
  assert.equal(pos.serverSl, '105');
  assert.equal(pos.serverTp, '130');
  near(pos.initialRisk!, 10);
});

test('should book realized PnL at the TP level and remove the position', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 4, entryPrice: 115, stopLoss: 90, takeProfit: 130 });
  engine.markAll({ BTCUSDT: 125 });
  near(engine.getAccount().equity, 100_040);
  const exits = engine.markAll({ BTCUSDT: 131 });
  assert.match(exits[0], /TAKE PROFIT/);
  assert.equal(engine.getPositions().length, 0);
  near(engine.getAccount().equity, 100_060);
});

test('should fill a breached stop at the market, not at the stop level', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'SELL', qty: 2, entryPrice: 100, stopLoss: 105, takeProfit: 90 });
  const exits = engine.markAll({ BTCUSDT: 106 });
  assert.match(exits[0], /STOP LOSS/);
  near(engine.getAccount().equity, 100_000 - 12);
});

test('should liquidate a 10x long at entry * (1 - 0.1 + 0.005)', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, leverage: 10, side: 'BUY', qty: 1, entryPrice: 100 });
  near(engine.getPositions()[0].liqDistancePct!, 9.5);
  const exits = engine.markAll({ BTCUSDT: 90 });
  assert.match(exits[0], /LIQUIDATED/);
  near(engine.getAccount().equity, 100_000 - 9.5);
});

test('should close the existing position and open the full opposite size on a flip', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 110 });
  let positions = engine.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'SHORT');
  near(positions[0].qty, 1);
  near(positions[0].entry, 110);
  near(engine.getAccount().equity, 100_020);
  engine.openPosition({ ...base, side: 'BUY', qty: 3, entryPrice: 110 });
  positions = engine.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'LONG');
  near(positions[0].qty, 3);
  near(engine.getAccount().equity, 100_020);
});

test('should keep strategies separate and close only the requested one', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.openPosition({ ...base, strategy: 'ADAPTIVE-ST-ζ', side: 'SELL', qty: 1, entryPrice: 100 });
  assert.equal(engine.getPositions().length, 2);
  engine.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 100, reduceOnly: true });
  assert.deepEqual(engine.getPositions().map((p) => p.strategy), ['ADAPTIVE-ST-ζ']);
});

test('should replace SL/TP through updateStops and ignore unknown positions', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100, stopLoss: 94, takeProfit: 112 });
  engine.updateStops('BTCUSDT', 'MOMENTUM-γ', 97, 115);
  assert.equal(engine.getPositions()[0].serverSl, '97');
  assert.equal(engine.getPositions()[0].serverTp, '115');
  engine.updateStops('ETHUSDT', 'MOMENTUM-γ', 1, 2);
  assert.equal(engine.getPositions().length, 1);
});

test('should reject a fill when no price is available', () => {
  assert.throws(() => freshEngine().openPosition({ ...base, symbol: 'XRPUSDT', side: 'BUY', qty: 1 }), /no price/);
});

test('should drop saved positions outside the tradable symbols', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'paper-')), 'state.json');
  const row = (symbol: string) => ({
    id: `${symbol}_MOMENTUM-γ`, orderId: '1', symbol, side: 'LONG', strategy: 'MOMENTUM-γ', entry: 100, qty: 1,
    mark: 100, upnl: 0, upnlPct: 0, leverage: 5, marginType: 'ISOLATED', liqDistancePct: null, serverSl: '—', serverTp: 'trail',
  });
  writeFileSync(filePath, JSON.stringify({ equity: 100_000, startEquity: 100_000, positions: [row('BTCUSDTETHUSDT'), row('BTCUSDT')] }));
  const engine = new PaperEngine(filePath);
  assert.deepEqual(engine.dropUnlistedSymbols(['BTCUSDT']), ['BTCUSDTETHUSDT']);
  assert.deepEqual(engine.getPositions().map((p) => p.symbol), ['BTCUSDT']);
});
