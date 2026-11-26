import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStrategies, STRATEGY_CATALOG } from '../src/core/composition/strategyCatalog.js';
import { EXECUTION_MODE, PaperOnlyViolationError, validatePaperOnlyConfig } from '../src/core/composition/validatePaperOnlyConfig.js';

const BASE = { PAPER_EXCHANGE_URL: 'http://127.0.0.1:3100/', PAPER_EXCHANGE_ACCOUNT_ID: 'acct-1' };

test('MODE=live is refused at startup, in any spelling', () => {
  for (const MODE of ['live', 'LIVE', ' Live ', 'shadow']) {
    assert.throws(() => validatePaperOnlyConfig({ ...BASE, MODE }), PaperOnlyViolationError, MODE);
  }
});

test('the default and an explicit paper mode produce a PAPER_ONLY config', () => {
  for (const env of [BASE, { ...BASE, MODE: 'paper' }, { ...BASE, MODE: 'PAPER' }]) {
    const config = validatePaperOnlyConfig(env);
    assert.equal(config.executionMode, EXECUTION_MODE);
    assert.equal(config.executionMode, 'PAPER_ONLY');
  }
});

test('trading credentials in the environment are never copied into the config', () => {
  const config = validatePaperOnlyConfig({ ...BASE, BINANCE_API_KEY: 'live-key', BINANCE_API_SECRET: 'live-secret', COINDCX_API_KEY: 'cx-key', COINDCX_API_SECRET: 'cx-secret' });
  const dump = JSON.stringify(config);
  for (const secret of ['live-key', 'live-secret', 'cx-key', 'cx-secret']) assert.ok(!dump.includes(secret));
});

test('PaperExchange is mandatory: there is no fallback venue', () => {
  assert.throws(() => validatePaperOnlyConfig({ PAPER_EXCHANGE_ACCOUNT_ID: 'a' }), /PAPER_EXCHANGE_URL/);
  assert.throws(() => validatePaperOnlyConfig({ PAPER_EXCHANGE_URL: 'http://x' }), /PAPER_EXCHANGE_ACCOUNT_ID/);
  assert.throws(() => validatePaperOnlyConfig({ ...BASE, PAPER_EXCHANGE_URL: 'not a url' }), /PAPER_EXCHANGE_URL/);
});

test('limits come from validated configuration and bad values are refused', () => {
  const config = validatePaperOnlyConfig({ ...BASE, SYMBOLS: 'BTCUSDT, ETHUSDT', RISK_PER_TRADE_PCT: '0.5', MAX_LEVERAGE: '3', MAX_EXPOSURE_PCT: '50', TAKER_FEE_RATE: '0.0005', SLIPPAGE_BUFFER_RATE: '0.0001' });
  assert.deepEqual(config.symbols, ['BTCUSDT', 'ETHUSDT']);
  assert.equal(config.limits.riskPerTradePct, 0.5);
  assert.equal(config.limits.maxLeverage, 3);
  assert.equal(config.limits.maxGrossExposurePct, 150);
  assert.equal(config.limits.maxConcurrentPositions, 2);
  assert.ok(Math.abs(config.limits.costRatePerLeg - 0.0006) < 1e-12);
  assert.equal(config.paperExchange.url, 'http://127.0.0.1:3100');
  assert.equal(config.advisor, null);
  assert.throws(() => validatePaperOnlyConfig({ ...BASE, RISK_PER_TRADE_PCT: '-1' }), /RISK_PER_TRADE_PCT/);
  assert.throws(() => validatePaperOnlyConfig({ ...BASE, MAX_LEVERAGE: '0' }), /MAX_LEVERAGE/);
  assert.throws(() => validatePaperOnlyConfig({ ...BASE, SYMBOLS: ' , ' }), /SYMBOLS is empty/);
  assert.throws(() => validatePaperOnlyConfig({ ...BASE, PAPER_CORE_STRATEGY_PARAMS: '{oops' }), /not valid JSON/);
  assert.throws(() => validatePaperOnlyConfig({ ...BASE, PAPER_CORE_STRATEGY_PARAMS: '[]' }), /JSON object/);
});

test('the advisor is opt-in', () => {
  const config = validatePaperOnlyConfig({ ...BASE, PAPER_CORE_ADVISOR: 'on', OLLAMA_MODEL: 'gemma', OLLAMA_API_KEY_1: ' k ' });
  assert.deepEqual(config.advisor, { host: 'https://ollama.com', model: 'gemma', timeoutMs: 5000, apiKey: 'k' });
});

test('the strategy catalog builds by id and rejects unknown ids, orphan parameters and bad parameters', () => {
  assert.deepEqual(Object.keys(STRATEGY_CATALOG).sort(), ['cross-sectional-momentum', 'mean-reversion-zscore', 'momentum-ema-cross', 'range-breakout']);
  const [momentum] = buildStrategies(['momentum-ema-cross'], { 'momentum-ema-cross': { emaPeriod: 20, timeframe: '1h' } });
  assert.equal(momentum.parameters.emaPeriod, 20);
  assert.equal(momentum.requirements.primaryTimeframe, '1h');
  assert.throws(() => buildStrategies(['nope']), /unknown strategies: nope/);
  assert.throws(() => buildStrategies(['range-breakout'], { 'momentum-ema-cross': {} }), /not enabled/);
  assert.throws(() => buildStrategies(['momentum-ema-cross'], { 'momentum-ema-cross': { emaPeriod: 1 } }), /emaPeriod/);
  assert.throws(() => buildStrategies(['momentum-ema-cross'], { 'momentum-ema-cross': { emaPeriodd: 20 } }), /momentum-ema-cross/);
  assert.throws(() => buildStrategies(['momentum-ema-cross'], { 'momentum-ema-cross': { timeframe: '7m' } }), /timeframe/);
});
