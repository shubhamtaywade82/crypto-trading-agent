import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { config } from '../src/config.js';
import { REPLAY_MAINTENANCE_TIERS } from '../src/risk/liquidation.js';
import type { Candle, RiskDecision, Signal } from '../src/types.js';

// The recorded values below depend on these limits and on the risk engine (the only sizing path). Each value was checked
// by hand: quantity = budget / (stop distance + fees), leverage from the confidence and stop width, and liquidation from
// the isolated-margin formula at the 1% replay maintenance tier. Pinning the limits keeps the table independent of a local .env.
Object.assign(config.risk, { minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2, minStopAtr: 2 });
const agent = (): RiskAgent => new RiskAgent({} as BinanceService, {});

const flatCandles = (range: number): Candle[] =>
  Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100 + range / 2, low: 100 - range / 2, close: 100, volume: 1 }));

const signal = (over: Partial<Signal>): Signal =>
  ({ id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 96, takeProfit: 110, reason: '', ts: 0, ...over });

// Every symbol gets the replay stand-in brackets
const TIERS_FOR_ANY_SYMBOL = new Proxy({}, { get: () => REPLAY_MAINTENANCE_TIERS }) as MarketContext['maintenance'];
const context = (over: Partial<MarketContext> = {}): MarketContext =>
  ({
    candles: { BTCUSDT: flatCandles(1.5), ETHUSDT: flatCandles(1.5) }, funding: {}, marks: {}, spot: {}, equity: 100_000,
    performance: { circuit: 'NORMAL', snapshot: { dailyLossPercent: 0, drawdownPercent: 0, lossStreak: 0, winStreak: 0, realizedToday: 0, profitFactor: 0, expectancy: 0 } },
    maintenance: TIERS_FOR_ANY_SYMBOL, ...over,
  });

const decision = (positionSizeUsdt: number, leverage: number, liqBufferAtr: number, reason: string): RiskDecision =>
  ({ approved: true, positionSizeUsdt, leverage, marginType: 'ISOLATED', liqBufferAtr, reason });
const rejected = (reason: string): RiskDecision =>
  ({ approved: false, positionSizeUsdt: 0, leverage: 0, marginType: 'ISOLATED', liqBufferAtr: 0, reason });

const FUNDING_REFUSED = 'funding harvest needs a delta-neutral leg (spot long + perp short), which is not implemented; refused';

interface Case { name: string; signal: Signal; ctx: MarketContext; expected: RiskDecision }

const cases: Case[] = [
  // Stop 4 above a 1.5 ATR: 2.67 ATR wide, leverage 8, liquidation 88.38 (clearance 5.08 ATR)
  { name: 'long momentum with stop and take-profit', signal: signal({}), ctx: context(), expected: decision(24_271.8, 8, 5.07744107744108, 'qty 242.718 notional $24272 lev 8x liq 88.38 clear 5.1xATR circuit NORMAL') },
  { name: 'short with stop and take-profit', signal: signal({ type: 'OPEN_SHORT', stopLoss: 104, takeProfit: 90, confidence: 0.9 }), ctx: context(), expected: decision(24_271.8, 9, 4.007334066740005, 'qty 242.718 notional $24272 lev 9x liq 110.01 clear 4.0xATR circuit NORMAL') },
  { name: 'minimum confidence gets minimum leverage', signal: signal({ confidence: 0.5 }), ctx: context(), expected: decision(24_271.8, 7, 6.279942279942276, 'qty 242.718 notional $24272 lev 7x liq 86.58 clear 6.3xATR circuit NORMAL') },
  // A 0.5 stop on a 0.2 ATR: the budget would be 161% of equity, so the portfolio cap refuses rather than shrinking
  { name: 'stop too tight for the exposure limit is refused, not shrunk', signal: signal({ stopLoss: 99.5 }), ctx: context({ candles: { BTCUSDT: flatCandles(0.2) } }), expected: rejected('risk-engine: portfolio_limits: symbol 161.29% (max 80%); gross 161.29% (max 80%); cluster BTC 161.29% (max 80%)') },
  { name: 'slash symbol is measured with the same ATR as any other symbol', signal: signal({ symbol: 'ETH/USDT' }), ctx: context({ candles: { 'ETH/USDT': flatCandles(1.5), ETHUSDT: flatCandles(1.5) } }), expected: decision(24_271.8, 8, 5.07744107744108, 'qty 242.718 notional $24272 lev 8x liq 88.38 clear 5.1xATR circuit NORMAL') },
  { name: 'missing stop', signal: signal({ stopLoss: undefined }), ctx: context(), expected: rejected('missing entry/SL') },
  { name: 'stop equal to entry', signal: signal({ stopLoss: 100 }), ctx: context(), expected: rejected('stop loss matches entry') },
  { name: 'long with a stop above entry is rejected', signal: signal({ stopLoss: 104 }), ctx: context(), expected: rejected('stop on wrong side of entry') },
  { name: 'short with a stop below entry is rejected', signal: signal({ type: 'OPEN_SHORT', stopLoss: 96 }), ctx: context(), expected: rejected('stop on wrong side of entry') },
  { name: 'stop narrower than the minimum ATR width', signal: signal({ stopLoss: 99 }), ctx: context(), expected: rejected('stop 0.7x ATR < 2x') },
  { name: 'a funding-harvest short is refused: it has no delta-neutral leg', signal: signal({ type: 'OPEN_FUNDING_SHORT', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, notionalUsdt: 5_000 }), ctx: context(), expected: rejected(FUNDING_REFUSED) },
  { name: 'a hedge is refused the same way', signal: signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, notionalUsdt: 5_000 }), ctx: context(), expected: rejected(FUNDING_REFUSED) },
  { name: 'insufficient candles', signal: signal({}), ctx: context({ candles: {} }), expected: rejected('insufficient candle history') },
  { name: 'zero ATR', signal: signal({}), ctx: context({ candles: { BTCUSDT: flatCandles(0) } }), expected: rejected('invalid ATR calculation') },
  { name: 'no venue brackets: entries refused, not sized against an assumed liquidation', signal: signal({}), ctx: context({ maintenance: {} }), expected: rejected('maintenance brackets for BTCUSDT not loaded; entries refused until the venue answers') },
  { name: 'zero equity trips the kill-switch', signal: signal({}), ctx: context({ equity: 0 }), expected: rejected('drawdown kill-switch: current drawdown exceeds 5%') },
];
for (const c of cases) {
  test(`golden: ${c.name}`, () => {
    const actual = agent().gate(c.signal, c.ctx);
    assert.deepEqual(actual, c.expected);
  });
}

test('golden: drawdown kill-switch follows the peak equity seen by one agent', () => {
  const risk = agent();
  const gateAt = (equity: number) => risk.gate(signal({}), context({ equity }));
  assert.equal(gateAt(100_000).approved, true);
  assert.deepEqual(gateAt(94_000), rejected('drawdown kill-switch: current drawdown exceeds 5%'));
  assert.equal(gateAt(96_000).approved, true);
  assert.equal(gateAt(100_000).approved, true);
});
