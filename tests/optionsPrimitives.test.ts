import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blackScholes, normCdf } from '../src/options/blackScholes.js';
import { contractFromExchangeInfo, floorToStep, parseOptionSymbol } from '../src/options/contract.js';
import { optionFee, walkBook } from '../src/options/execution.js';
import { canTransition, IllegalTransitionError, transition, type OptionTradeEvent } from '../src/options/OptionPositionMachine.js';
import { rawSymbol } from './support/optionsFixture.js';

test('parses Binance option symbols into CE/PE contracts expiring 08:00 UTC', () => {
  const call = parseOptionSymbol('BTC-261030-81000-C');
  assert.deepEqual(call, { base: 'BTC', underlying: 'BTCUSDT', strike: 81_000, right: 'CE', expiryDate: '2026-10-30', expiryMs: Date.UTC(2026, 9, 30, 8) });
  assert.equal(parseOptionSymbol('xrp-261030-1.3-p')?.right, 'PE');
  assert.equal(parseOptionSymbol('XRP-261030-1.3-P')?.strike, 1.3);
});

test('refuses malformed symbols and impossible dates', () => {
  for (const bad of ['BTCUSDT', 'BTC-261030-81000', 'BTC-261030-81000-X', 'BTC-261331-81000-C', 'BTC-260230-81000-C', 'BTC-261030-0-C']) {
    assert.equal(parseOptionSymbol(bad), null, bad);
  }
});

test('builds a contract only when every exchangeInfo field verifies', () => {
  const ok = contractFromExchangeInfo(rawSymbol('BTC-261030-80000-C'));
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && { unit: ok.contract.unit, minQty: ok.contract.minQty, step: ok.contract.qtyStep, tick: ok.contract.tickSize }, { unit: 1, minQty: 0.01, step: 0.01, tick: 5 });

  const cases: Array<[string, Parameters<typeof rawSymbol>[1], RegExp]> = [
    ['strike', { strikePrice: 79_000 }, /strike/],
    ['underlying', { underlying: 'ETHUSDT' }, /underlying/],
    ['expiry', { expiryDate: Date.UTC(2026, 9, 31, 8) }, /expiry/],
    ['unit', { unit: undefined }, /unit/],
    ['lot', { filters: [{ filterType: 'PRICE_FILTER', tickSize: '5' }] }, /LOT_SIZE/],
    ['tick', { filters: [{ filterType: 'LOT_SIZE', minQty: '0.01', stepSize: '0.01' }] }, /tick/],
    ['status', { status: 'PENDING_TRADING' }, /status/],
  ];
  for (const [name, overrides, reason] of cases) {
    const result = contractFromExchangeInfo(rawSymbol('BTC-261030-80000-C', overrides));
    assert.ok(!result.ok, name);
    assert.match(!result.ok ? result.reason : '', reason, name);
  }
});

test('floors quantities to the lot step without float drift', () => {
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(floorToStep(1.029, 0.01), 1.02);
  assert.equal(floorToStep(7, 5), 5);
  assert.equal(floorToStep(-1, 0.01), 0);
  assert.equal(floorToStep(1, 0), 0);
});

test('Black-Scholes satisfies put-call parity and prices expiry at intrinsic', () => {
  const base = { spot: 80_000, strike: 81_000, timeToExpiryMs: 5 * 86_400_000, vol: 0.5, rate: 0.02 };
  const call = blackScholes({ ...base, right: 'CE' })!;
  const put = blackScholes({ ...base, right: 'PE' })!;
  const t = base.timeToExpiryMs / (365 * 86_400_000);
  assert.ok(Math.abs(call.price - put.price - (base.spot - base.strike * Math.exp(-base.rate * t))) < 1e-3);
  assert.ok(call.delta > 0.4 && call.delta < 0.5 && put.delta < 0 && Math.abs(call.delta - put.delta - 1) < 1e-9);
  assert.ok(call.thetaPerDay < 0 && put.thetaPerDay < 0 && call.gamma > 0);
  assert.deepEqual(blackScholes({ ...base, right: 'CE', spot: 82_000, timeToExpiryMs: 0 }), { price: 1_000, delta: 1, gamma: 0, thetaPerDay: 0, vega: 0 });
  assert.equal(blackScholes({ ...base, right: 'CE', vol: 0 }), null);
  assert.equal(blackScholes({ ...base, right: 'CE', spot: 0 }), null);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7 && Math.abs(normCdf(1.96) - 0.975) < 1e-4);
});

test('charges min(rate x index x qty x unit, cap x premium x qty), and the cap without an index', () => {
  const fees = { rate: 0.0003, cap: 0.1 };
  assert.ok(Math.abs(optionFee(fees, 1_250, 0.5, 80_932, 1) - 12.1398) < 1e-9);
  assert.equal(optionFee(fees, 5, 1, 80_932, 1), 0.5);
  assert.equal(optionFee(fees, 40, 1, 0, 1), 4);
  assert.equal(optionFee(fees, 40, 0, 80_000, 1), 0);
});

test('walks the book to a VWAP, stops at the limit and floors to the lot', () => {
  const contract = { qtyStep: 0.01, minQty: 0.01 };
  const asks = [[100, 0.5], [102, 1], [110, 5]] as const;
  const full = walkBook(asks, 'buy', 1.2, 105, contract);
  assert.equal(full.qty, 1.2);
  assert.ok(Math.abs(full.avgPrice - (0.5 * 100 + 0.7 * 102) / 1.2) < 1e-9);
  assert.equal(full.partial, false);

  const capped = walkBook(asks, 'buy', 3, 105, contract);
  assert.deepEqual([capped.qty, capped.partial], [1.5, true]);

  const bids = [[99, 0.005], [90, 1]] as const;
  assert.deepEqual(walkBook(bids, 'sell', 1, 95, contract), { qty: 0, avgPrice: 0, partial: true });
  assert.equal(walkBook(bids, 'sell', 1, 85, contract).qty, 1);
});

test('the trade state machine allows only its table and throws on anything else', () => {
  const path: OptionTradeEvent[] = ['SIGNAL', 'SUBMIT', 'FILL', 'EXIT_TRIGGER', 'PARTIAL_EXIT', 'EXIT_RETRY', 'EXIT_FILL', 'RESET'];
  let state = transition('IDLE', path[0]);
  for (const event of path.slice(1)) state = transition(state, event);
  assert.equal(state, 'IDLE');
  assert.equal(transition('IDLE', 'ADOPT'), 'POSITION_OPEN');
  assert.equal(transition('POSITION_OPEN', 'EXTERNAL_CLOSE'), 'POSITION_CLOSED');
  assert.throws(() => transition('IDLE', 'FILL'), IllegalTransitionError);
  assert.throws(() => transition('POSITION_OPEN', 'SUBMIT'), /SUBMIT from POSITION_OPEN/);
  assert.throws(() => transition('ENTRY_PENDING', 'SIGNAL'), IllegalTransitionError);
  assert.equal(canTransition('POSITION_CLOSED', 'SIGNAL'), false);
});
