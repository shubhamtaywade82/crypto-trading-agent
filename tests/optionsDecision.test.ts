import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionsConfigFromEnv } from '../src/options/config.js';
import { contractFromExchangeInfo } from '../src/options/contract.js';
import { evaluateEconomics, screenContracts, selectContract } from '../src/options/ContractSelector.js';
import { directionFor, realizedVolatility } from '../src/options/DirectionEngine.js';
import { evaluateExit, type ManagedLeg } from '../src/options/ExitPolicy.js';
import { OptionChainService } from '../src/options/OptionChainService.js';
import { OptionRiskBook, planEntry } from '../src/options/OptionRiskPlanner.js';
import type { OptionContract, OptionQuote } from '../src/options/types.js';
import { EXPIRY, FakeOptionsMarket, hourlyCandles, marketState, rawSymbol, SPOT, T0, testConfig } from './support/optionsFixture.js';

const cfg = testConfig();
const fees = cfg.fees;
const economics = { ...cfg.economics, stopPct: cfg.exits.stopPct, targetPct: cfg.exits.targetPct };
const contractOf = (symbol: string, overrides = {}): OptionContract => {
  const r = contractFromExchangeInfo(rawSymbol(symbol, overrides));
  if (!r.ok) throw new Error(r.reason);
  return r.contract;
};

async function chainAt(now: number, market = new FakeOptionsMarket(() => now)) {
  const chain = new OptionChainService(market, { now: () => now });
  return { market, chain, index: await chain.index('BTCUSDT'), marks: await chain.marks(), contracts: await chain.contractsFor('BTCUSDT') };
}

// ---- direction ---------------------------------------------------------------------------------------------------

test('reads CE on an aligned uptrend, PE on an aligned downtrend, nothing otherwise', () => {
  const t = cfg.direction;
  assert.equal(directionFor(marketState('BULL'), hourlyCandles(), t).right, 'CE');
  assert.equal(directionFor(marketState('BEAR'), hourlyCandles(), t).right, 'PE');
  assert.equal(directionFor(marketState('FLAT'), hourlyCandles(), t).right, null);
  assert.match(directionFor(marketState('BULL', { adx: 12 }), hourlyCandles(), t).reasons[0], /ADX 12.0 below 20/);
  assert.match(directionFor(marketState('BULL', { rsi: 78 }), hourlyCandles(), t).reasons[0], /RSI 78.0 above 70/);
  assert.match(directionFor(marketState('BEAR', { rsi: 22 }), hourlyCandles(), t).reasons[0], /RSI 22.0 below 30/);
});

test('realized volatility annualises hourly log returns and refuses short history', () => {
  const rv = realizedVolatility(hourlyCandles())!;
  assert.ok(rv > 0.44 && rv < 0.47, String(rv));
  assert.equal(realizedVolatility(hourlyCandles(20)), null);
});

// ---- selection ---------------------------------------------------------------------------------------------------

test('screens by side, DTE, unit, IV, model consistency and delta band, nearest target delta first', async () => {
  const { market, index, marks } = await chainAt(T0);
  const contracts = [
    contractOf('BTC-261030-80000-C'),
    contractOf('BTC-261030-95000-C'), // delta far below band
    contractOf('BTC-261030-80000-P'), // wrong side
    contractOf('BTC-261030-81000-C', { unit: 10 }), // unverified unit
  ];
  market.symbols.push(rawSymbol('BTC-261030-81000-C', { unit: 10 }));
  const { candidates, rejected } = screenContracts({ contracts, marks: await new OptionChainService(market, { now: () => T0 }).marks(), index, right: 'CE', now: T0, limits: cfg.selection });
  assert.deepEqual(candidates.map((c) => c.contract.symbol), ['BTC-261030-80000-C']);
  assert.deepEqual(rejected, { 'delta outside band': 1, 'contract unit 10 not verified': 1 });
  assert.ok(Math.abs(candidates[0].greeks.delta - 0.53) < 0.02);
  void marks;
});

test('refuses a contract whose mark disagrees with the model at its own IV (premium scale, as with the XRP snapshot)', async () => {
  const market = new FakeOptionsMarket(() => T0);
  market.markOverrides.set('BTC-261030-80000-C', 18_000); // ~10x the model price
  market.ivOverrides.set('BTC-261030-80000-P', null);
  const { index, marks, contracts } = await chainAt(T0, market);
  const call = screenContracts({ contracts, marks, index, right: 'CE', now: T0, limits: cfg.selection });
  const put = screenContracts({ contracts, marks, index, right: 'PE', now: T0, limits: cfg.selection });
  assert.equal(call.rejected['mark disagrees with model'], 1);
  assert.equal(put.rejected['no mark IV'], 1);
});

test('refuses expiries outside the DTE window', async () => {
  const late = EXPIRY - 20 * 3_600_000; // 20 h left, below the 24 h minimum
  const { index, marks, contracts } = await chainAt(late);
  const { candidates, rejected } = screenContracts({ contracts, marks, index, right: 'CE', now: late, limits: cfg.selection });
  assert.equal(candidates.length, 0);
  assert.equal(rejected['expiry outside DTE window'], 2);
});

test('the economics gate refuses stale, one-sided, crossed, wide and expensive markets, and passes a clean one', async () => {
  const { chain, index, marks, contracts } = await chainAt(T0);
  const screened = screenContracts({ contracts, marks, index, right: 'CE', now: T0, limits: cfg.selection }).candidates[0];
  const quote = await chain.quote(screened.contract.symbol, screened.mark);
  const base = { screened, quote, index, realizedVol: 0.45, atr1h: 600, now: T0, selection: cfg.selection, economics, fees };
  const withBook = (bids: Array<[number, number]>, asks: Array<[number, number]>): OptionQuote => ({ ...quote, bids, asks });

  const ok = evaluateEconomics(base);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.ok(ok.economics.edgeRatio > 5, `edge ${ok.economics.edgeRatio}`);
    assert.ok(Math.abs(ok.economics.rewardRisk - 2) < 1e-9);
    assert.ok(ok.economics.breakevenMovePct > 0.1 && ok.economics.breakevenMovePct < 0.3);
  }
  const reasonOf = (r: ReturnType<typeof evaluateEconomics>) => (r.ok ? 'ok' : r.reason);
  assert.match(reasonOf(evaluateEconomics({ ...base, now: T0 + 11_000 })), /quote stale/);
  assert.match(reasonOf(evaluateEconomics({ ...base, index: { ...index, receivedAt: T0 - 11_000 } })), /index stale/);
  assert.match(reasonOf(evaluateEconomics({ ...base, quote: withBook([], quote.asks as Array<[number, number]>) })), /one-sided/);
  assert.match(reasonOf(evaluateEconomics({ ...base, quote: withBook([[2_000, 1]], [[1_990, 1]]) })), /crossed/);
  assert.match(reasonOf(evaluateEconomics({ ...base, quote: withBook([[1_700, 1]], [[2_000, 1]]) })), /spread 16\.\d+% above 8%/);
  assert.match(reasonOf(evaluateEconomics({ ...base, realizedVol: 0.25 })), /IV\/RV 2\.00 above 1\.5/);
  assert.match(reasonOf(evaluateEconomics({ ...base, atr1h: 40 })), /edge ratio/);
  assert.match(reasonOf(evaluateEconomics({ ...base, economics: { ...economics, targetPct: 30 } })), /reward:risk 1\.00 below 1\.5/);
});

test('selectContract only pays for depth on screened candidates and reports why each was refused', async () => {
  const { market, chain, index, marks, contracts } = await chainAt(T0);
  market.books.set('BTC-261030-80000-C', { bids: [[1_000, 1]], asks: [[2_500, 1]] });
  const result = await selectContract({
    contracts, marks, index, right: 'CE', realizedVol: 0.45, atr1h: 600, now: () => T0,
    selection: cfg.selection, economics, fees, fetchQuote: (s, m) => chain.quote(s, m),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(market.depthCalls, ['BTC-261030-80000-C']);
  assert.ok(!result.ok && result.reasons.some((r) => /1x delta outside band/.test(r)) && result.reasons.some((r) => /BTC-261030-80000-C: spread/.test(r)));
});

// ---- sizing ------------------------------------------------------------------------------------------------------

const quoteWith = (asks: Array<[number, number]>, bids: Array<[number, number]> = [[1_850, 10]]): OptionQuote =>
  ({ symbol: 'BTC-261030-80000-C', asks, bids, mark: 1_865, markIv: 0.5, riskFreeRate: 0, receivedAt: T0 });

test('sizing takes the smallest of the risk, premium and portfolio ceilings, then what the book can fill', () => {
  const contract = contractOf('BTC-261030-80000-C');
  const params = { equity: 100_000, exposure: { premiumAtRisk: 0, openPositions: 0 }, contract, quote: quoteWith([[1_880, 10]]), indexPrice: SPOT, stopPct: 30, targetPct: 60, limits: cfg.risk, fees };

  const premiumBound = planEntry(params);
  assert.ok(premiumBound.ok);
  if (premiumBound.ok) {
    assert.equal(premiumBound.plan.binding, 'premium');
    assert.equal(premiumBound.plan.qty, 1.03); // 2% of 100k / (limit 1917.6 + fee 24) = 1.030
    assert.ok(premiumBound.plan.worstCaseLoss <= 2_000 + 1e-6);
    assert.ok(premiumBound.plan.plannedLoss <= 1_000);
    assert.ok(Math.abs(premiumBound.plan.stopPremium - 1_880 * 0.7) < 1e-9);
  }

  const riskBound = planEntry({ ...params, limits: { ...cfg.risk, riskPerTradePct: 0.5 } });
  assert.ok(riskBound.ok && riskBound.plan.binding === 'risk' && riskBound.plan.plannedLoss <= 500);

  const portfolioBound = planEntry({ ...params, exposure: { premiumAtRisk: 5_500, openPositions: 1 } });
  assert.ok(portfolioBound.ok && portfolioBound.plan.binding === 'portfolio' && portfolioBound.plan.qty === 0.25);

  const bookBound = planEntry({ ...params, quote: quoteWith([[1_880, 0.3], [2_500, 10]]) });
  assert.ok(bookBound.ok && bookBound.plan.binding === 'book' && bookBound.plan.qty === 0.3);
});

test('sizing refuses below one lot, at the position limit, at the portfolio cap and on an empty book', () => {
  const contract = contractOf('BTC-261030-80000-C');
  const params = { equity: 100_000, exposure: { premiumAtRisk: 0, openPositions: 0 }, contract, quote: quoteWith([[1_880, 10]]), indexPrice: SPOT, stopPct: 30, targetPct: 60, limits: cfg.risk, fees };
  const reason = (r: ReturnType<typeof planEntry>) => (r.ok ? 'ok' : r.reason);
  assert.match(reason(planEntry({ ...params, equity: 500 })), /below min qty 0.01/);
  assert.match(reason(planEntry({ ...params, exposure: { premiumAtRisk: 0, openPositions: 2 } })), /2 open positions/);
  assert.match(reason(planEntry({ ...params, exposure: { premiumAtRisk: 6_000, openPositions: 1 } })), /portfolio premium cap/);
  assert.match(reason(planEntry({ ...params, quote: quoteWith([]) })), /no ask/);
  assert.match(reason(planEntry({ ...params, quote: quoteWith([[1_880, 0.001], [2_500, 10]]) })), /book cannot fill/);
  assert.match(reason(planEntry({ ...params, equity: 0 })), /no equity/);
});

test('the risk book halts on the daily loss or the loss streak, and rolls at UTC midnight', () => {
  const book = new OptionRiskBook({ maxDailyLossPct: 3, maxLossStreak: 2 }, null, 10_000, T0);
  book.record({ pnl: -200, closedAt: T0 });
  assert.equal(book.haltReason(), null);
  book.record({ pnl: 50, closedAt: T0 });
  book.record({ pnl: -120, closedAt: T0 });
  assert.equal(book.haltReason(), null); // -270 < 300 limit; streak 1 after the winner reset it
  book.record({ pnl: -40, closedAt: T0 });
  assert.match(book.haltReason() ?? '', /daily loss 310.00 >= 300.00/);
  const nextDay = T0 + 86_400_000;
  book.rollIfNewDay(9_690, nextDay);
  assert.match(book.haltReason() ?? '', /2 losses in a row/);
  book.record({ pnl: 10, closedAt: nextDay });
  assert.equal(book.haltReason(), null);
  const restored = new OptionRiskBook({ maxDailyLossPct: 3, maxLossStreak: 2 }, book.snapshot(), 1, nextDay);
  assert.deepEqual(restored.snapshot(), book.snapshot());
});

// ---- exits -------------------------------------------------------------------------------------------------------

const leg: ManagedLeg = { right: 'CE', entryPrice: 100, stopPremium: 70, targetPremium: 160, peakBid: 100, trailActive: false, openedAt: T0, expiryMs: EXPIRY };
const q = (bid: number | null, receivedAt = T0): OptionQuote => ({ symbol: 'X', bids: bid === null ? [] : [[bid, 1]], asks: [[(bid ?? 100) + 2, 1]], mark: bid ?? 100, markIv: 0.5, riskFreeRate: 0, receivedAt });
const exitOf = (overrides: Partial<Parameters<typeof evaluateExit>[0]>) => evaluateExit({ leg, quote: q(100), now: T0, staleMs: 10_000, limits: cfg.exits, direction: 'CE', ...overrides });

test('exits on the executable bid: stop, target, thesis flip', () => {
  assert.equal(exitOf({}).action, 'HOLD');
  assert.deepEqual(['STOP_LOSS', 70], ((d) => (d.action === 'EXIT' ? [d.reason, d.bid] : []))(exitOf({ quote: q(70) })));
  assert.equal(((d) => d.action === 'EXIT' && d.reason)(exitOf({ quote: q(161) })), 'TAKE_PROFIT');
  assert.equal(((d) => d.action === 'EXIT' && d.reason)(exitOf({ direction: 'PE' })), 'THESIS_INVALIDATED');
  assert.equal(exitOf({ direction: null }).action, 'HOLD');
  assert.deepEqual(((d) => d.action === 'HOLD' && d.note)(exitOf({ quote: q(null) })), 'no bid');
});

test('the trailing stop arms after the move, only ratchets up, and labels its exit', () => {
  const armed = exitOf({ quote: q(140) });
  assert.equal(armed.action, 'HOLD');
  assert.equal(armed.leg.trailActive, true);
  assert.ok(Math.abs(armed.leg.stopPremium - 112) < 1e-9);
  const lower = exitOf({ leg: armed.leg, quote: q(120) });
  assert.equal(lower.leg.stopPremium, armed.leg.stopPremium);
  const hit = exitOf({ leg: armed.leg, quote: q(111) });
  assert.ok(hit.action === 'EXIT' && hit.reason === 'TRAILING_STOP');
});

test('time exits fire without a price; price exits wait for a fresh quote', () => {
  const preExpiry = exitOf({ now: EXPIRY - 5 * 3_600_000, quote: null });
  assert.ok(preExpiry.action === 'EXIT' && preExpiry.reason === 'PRE_EXPIRY' && preExpiry.bid === null);
  const timeStop = exitOf({ now: T0 + 24 * 3_600_000, quote: q(50, T0) });
  assert.ok(timeStop.action === 'EXIT' && timeStop.reason === 'TIME_STOP');
  const stale = exitOf({ now: T0 + 11_000, quote: q(50, T0) });
  assert.ok(stale.action === 'STALE' && stale.ageMs === 11_000);
});

// ---- config ------------------------------------------------------------------------------------------------------

test('config defaults to the local paper venue with every risk control on', () => {
  const c = optionsConfigFromEnv({});
  assert.equal(c.venue, 'local');
  assert.deepEqual(c.underlyings, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
  assert.deepEqual([c.exits.stopPct, c.risk.riskPerTradePct, c.risk.maxPremiumPct, c.llmVeto], [30, 1, 2, true]);
  assert.deepEqual(c.selection.allowedUnits, [1]);
});

test('config refuses venues that cannot execute options and inconsistent limits', () => {
  const refuse = (env: Record<string, string>, pattern: RegExp) => assert.throws(() => optionsConfigFromEnv(env), pattern);
  refuse({ OPTIONS_VENUE: 'coindcx' }, /coindcx-sdk 1\.3\.0 exposes no options endpoints/);
  refuse({ OPTIONS_VENUE: 'coindcx_live' }, /coindcx_monitor/);
  refuse({ OPTIONS_VENUE: 'binance_live' }, /Binance live options execution is not wired/);
  refuse({ OPTIONS_VENUE: 'kraken' }, /must be one of local, paper_exchange, coindcx_monitor/);
  refuse({ OPTIONS_VENUE: 'paper_exchange' }, /OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID/);
  refuse({ OPTIONS_EXIT_BEFORE_EXPIRY_HOURS: '30' }, /force-exited at once/);
  refuse({ OPTIONS_RISK_PER_TRADE_PCT: '3' }, /cannot exceed OPTIONS_MAX_PREMIUM_PCT/);
  refuse({ OPTIONS_TARGET_DELTA: '0.7' }, /OPTIONS_MIN_DELTA < OPTIONS_TARGET_DELTA < OPTIONS_MAX_DELTA/);
  refuse({ OPTIONS_UNDERLYINGS: 'BTC' }, /USDT underlyings/);
  refuse({ OPTIONS_STOP_PCT: '100' }, /OPTIONS_STOP_PCT/);
  const pe = optionsConfigFromEnv({ OPTIONS_VENUE: 'paper_exchange', PAPER_EXCHANGE_URL: 'http://pe:3000/', OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID: 'crypto-options' });
  assert.deepEqual(pe.paperExchange, { url: 'http://pe:3000', accountId: 'crypto-options', apiKey: undefined });
});
