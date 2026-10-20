import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMtfScreen, type MtfScreenProps } from '../src/ui/mtfPanels.js';
import type { Candle, MarketPriceInfo } from '../src/types.js';
import type { MarketState, TimeframeState, StructureState } from '../src/market/types.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function mockTimeframe(lastClose: number, trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): TimeframeState {
  return {
    timeframe: '15m',
    candleCount: 50,
    lastClose,
    ema20: trend === 'BULLISH' ? lastClose - 1 : lastClose + 1,
    ema50: trend === 'BULLISH' ? lastClose - 2 : lastClose + 2,
    ema200: trend === 'BULLISH' ? lastClose - 5 : lastClose + 5,
    emaSlopePct: trend === 'BULLISH' ? 0.05 : -0.05,
    adx14: 25,
    atr14: 1.5,
    atrPercentile: 50,
    rsi14: 55,
    vwap: lastClose,
    bollingerMiddle: lastClose,
    bollingerUpper: lastClose + 3,
    bollingerLower: lastClose - 3,
  };
}

function mockStructure(trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): StructureState {
  return {
    timeframe: '15m',
    trend,
    swingHighs: [],
    swingLows: [],
    lastBreak: {
      type: 'BOS',
      direction: trend === 'BEARISH' ? 'BEARISH' : 'BULLISH',
      level: 100,
      index: 10,
      time: Date.now() - 60_000,
      distanceAtr: 1.2,
    },
    protectedHigh: null,
    protectedLow: null,
  };
}

function mockMarketState(sym: string, price: number, trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): MarketState {
  return {
    version: 1,
    symbol: sym,
    generatedAt: Date.now(),
    mark: price,
    fundingRate: 0.0001,
    timeframes: {
      '15m': mockTimeframe(price, trend),
      '1h': mockTimeframe(price, trend),
      '4h': mockTimeframe(price, trend),
    },
    ltfStructure: mockStructure(trend),
    htfStructure: mockStructure(trend),
    regime: {
      regime: trend === 'BULLISH' ? 'TREND_UP' : trend === 'BEARISH' ? 'TREND_DOWN' : 'RANGE',
      confidence: 0.8,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      trendDirection: trend,
      trendStrength: 0.7,
      adx14: 25,
      emaSlopePct: 0.05,
    },
    liquidity: {
      ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] },
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
    },
    zones: [],
    pricing: {
      high: price + 10,
      low: price - 10,
      equilibrium: price,
      positionPct: 60,
      premium: true,
      discount: false,
    },
    meanReversion: {
      mean: price,
      vwap: price,
      zscore: 0.5,
      rsi14: 55,
      bollingerMiddle: price,
      bollingerUpper: price + 5,
      bollingerLower: price - 5,
      deviationPct: 0.1,
    },
  };
}

function mockCandles(count: number, basePrice: number): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const p = basePrice + i * 2;
    candles.push({
      openTime: now - (count - i) * 900_000,
      open: p - 1,
      high: p + 3,
      low: p - 2,
      close: p + 1,
      volume: 1000 + i * 100,
    });
  }
  return candles;
}

test('renderMtfScreen: renders empty/initial props without throwing', () => {
  const props: MtfScreenProps = {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
    selectedSymbol: 'BTCUSDT',
    selectedTimeframe: '15m',
    time: '12:00:00',
    totalWidth: 128,
    totalHeight: 40,
    wsStatus: 'down',
    mode: 'paper',
  };
  const lines = renderMtfScreen(props);
  assert.ok(lines.length >= 10);
  for (const line of lines) {
    assert.ok(strip(line).length > 0);
  }
});

test('renderMtfScreen: displays Anchor and all 4 symbols in matrix', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const spotPrices: Record<string, MarketPriceInfo> = {
    BTCUSDT: { price: 67000, changePct: 2.0, high24h: 68000, low24h: 66000, volumeQuote: 3e9 },
    ETHUSDT: { price: 2600, changePct: 0.5, high24h: 2700, low24h: 2550, volumeQuote: 1e9 },
    SOLUSDT: { price: 180, changePct: 4.5, high24h: 185, low24h: 172, volumeQuote: 5e8 },
    XRPUSDT: { price: 0.55, changePct: 2.5, high24h: 0.56, low24h: 0.53, volumeQuote: 2e8 },
  };

  const marketStates: Record<string, MarketState> = {
    BTCUSDT: mockMarketState('BTCUSDT', 67000, 'BULLISH'),
    ETHUSDT: mockMarketState('ETHUSDT', 2600, 'BEARISH'),
    SOLUSDT: mockMarketState('SOLUSDT', 180, 'BULLISH'),
    XRPUSDT: mockMarketState('XRPUSDT', 0.55, 'BULLISH'),
  };

  const mtfCandles = {
    SOLUSDT: {
      '15m': mockCandles(20, 170),
    },
  };

  const props: MtfScreenProps = {
    symbols,
    selectedSymbol: 'SOLUSDT',
    selectedTimeframe: '15m',
    marketStates,
    spotPrices,
    mtfCandles,
    time: '12:00:00',
    totalWidth: 140,
    totalHeight: 40,
    wsStatus: 'connected',
    mode: 'paper',
  };

  const lines = renderMtfScreen(props);
  const text = lines.map(strip).join('\n');

  // Verify header and anchor section
  assert.ok(text.includes('ANCHOR (BTCUSDT)'));
  assert.ok(text.includes('PERMISSIVE'));

  // Verify symbols appear in the matrix
  for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
    assert.ok(text.includes(sym), `Matrix should list ${sym}`);
  }

  // Verify SOLUSDT relative strength shows as LEADER (+4.5% vs +2.0% = +2.5%)
  assert.ok(text.includes('LEADER'), 'SOL should be tagged as LEADER');

  // Verify ETHUSDT shows as LAGGARD (+0.5% vs +2.0% = -1.5%)
  assert.ok(text.includes('LAGGARD'), 'ETH should be tagged as LAGGARD');

  // Verify Candlestick plot rows exist with wicks or bodies
  assert.ok(text.includes('Volume'), 'Chart should include volume row');
  assert.ok(text.includes('│'), 'Chart should include axis or wicks');
});

test('renderMtfScreen: correctly switches timeframe and selected symbol', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const props: MtfScreenProps = {
    symbols,
    selectedSymbol: 'XRPUSDT',
    selectedTimeframe: '1h',
    time: '12:00:00',
    totalWidth: 120,
    totalHeight: 40,
    wsStatus: 'connected',
    mode: 'live',
  };

  const text = renderMtfScreen(props).map(strip).join('\n');
  assert.ok(text.includes('XRPUSDT Timeframe:'));
  assert.ok(text.includes('[1h*]'), 'Should show 1h as selected timeframe');
  assert.ok(text.includes('[LIVE]'), 'Should show LIVE mode');
});
