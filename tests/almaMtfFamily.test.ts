import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ALMA_MTF_PARAMS, type AlmaMtfParams } from '../src/agents/AlmaMtfChampionAgent.js';
import { FIFTEEN_MINUTES_MS, type ReplayData } from '../src/backtesting/types.js';
import { almaMtfCandidate, resolvedReplayConfig, runAlmaMtfExperiment } from '../src/research/pipeline/almaMtfFamily.js';
import { candidateId, datasetHash } from '../src/research/pipeline/experimentIdentity.js';
import type { Candle } from '../src/types.js';

/** Slow sine swings (multi-day trends both ways) plus a short wobble, so 1h ALMA crosses agree with the 4h trend. */
function swingCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let previousClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + 25 * Math.sin(i / 450) + 1.5 * Math.sin(i / 20);
    const open = previousClose;
    candles.push({
      openTime: i * FIFTEEN_MINUTES_MS,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume: 1_000,
    });
    previousClose = close;
  }
  return candles;
}

const BAR_COUNT = 3_200;
const data: ReplayData = { SOLUSDT: { '15m': swingCandles(BAR_COUNT) } };
const replayConfig = resolvedReplayConfig({ positionManager: false, learning: false });
const mutated: AlmaMtfParams = { ...DEFAULT_ALMA_MTF_PARAMS, fast: { ...DEFAULT_ALMA_MTF_PARAMS.fast, length: 9 }, atrStopMultiplier: 1.5 };

// Each full replay costs seconds; share the runs the tests compare
let defaultRun: ReturnType<typeof runAlmaMtfExperiment> | undefined;
let mutatedRun: ReturnType<typeof runAlmaMtfExperiment> | undefined;
const runDefault = () => (defaultRun ??= runAlmaMtfExperiment(DEFAULT_ALMA_MTF_PARAMS, data, replayConfig));
const runMutated = () => (mutatedRun ??= runAlmaMtfExperiment(mutated, data, replayConfig));

const tradeKeys = (trades: { openedAt: number; side: string; entry: number; exit: number }[]) =>
  trades.map((t) => `${t.openedAt}|${t.side}|${t.entry.toFixed(6)}|${t.exit.toFixed(6)}`);

test('should reject params outside the family schema instead of clamping them', () => {
  assert.throws(() => almaMtfCandidate({ ...DEFAULT_ALMA_MTF_PARAMS, fast: { ...DEFAULT_ALMA_MTF_PARAMS.fast, length: 60 } }), /fast.length must be below slow.length/);
  assert.throws(() => almaMtfCandidate({ ...DEFAULT_ALMA_MTF_PARAMS, atrStopMultiplier: 0 }), /atrStopMultiplier/);
  assert.throws(() => almaMtfCandidate({ ...DEFAULT_ALMA_MTF_PARAMS, extra: 1 }), /invalid ALMA_MTF params/);
});

test('should give the same candidate id regardless of key order and a new id when a param changes', () => {
  const reordered = Object.fromEntries(Object.entries(DEFAULT_ALMA_MTF_PARAMS).reverse());
  assert.equal(candidateId(almaMtfCandidate(reordered)), candidateId(almaMtfCandidate(DEFAULT_ALMA_MTF_PARAMS)));
  assert.notEqual(candidateId(almaMtfCandidate(mutated)), candidateId(almaMtfCandidate(DEFAULT_ALMA_MTF_PARAMS)));
});

test('should change the dataset hash when any candle changes', () => {
  const changed = swingCandles(BAR_COUNT);
  changed[10] = { ...changed[10], close: changed[10].close + 0.01 };
  assert.notEqual(datasetHash({ SOLUSDT: { '15m': changed } }), datasetHash(data));
});

test('should reproduce identical identity, trades and metrics when an experiment is re-run', async () => {
  const first = await runDefault();
  const second = await runAlmaMtfExperiment(DEFAULT_ALMA_MTF_PARAMS, data, replayConfig);
  assert.ok(first.result.trades.length > 0, 'fixture must make the default candidate trade through the full replay');
  assert.deepEqual(second.identity, first.identity);
  assert.deepEqual(tradeKeys(second.result.trades), tradeKeys(first.result.trades));
  assert.deepEqual(second.result.metrics, first.result.metrics);
});

test('should change generated trades, not only metadata, when params mutate', async () => {
  const base = await runDefault();
  const variant = await runMutated();
  assert.notEqual(variant.identity.experimentId, base.identity.experimentId);
  assert.notDeepEqual(tradeKeys(variant.result.trades), tradeKeys(base.result.trades));
});

test('should take the same entries before a cut whether or not later bars exist (no lookahead)', async () => {
  const cutBars = 2_400;
  const truncated: ReplayData = { SOLUSDT: { '15m': data.SOLUSDT['15m']!.slice(0, cutBars) } };
  const full = await runMutated();
  const partial = await runAlmaMtfExperiment(mutated, truncated, replayConfig);
  // A decision at the truncated run's last step is never filled, so compare decisions strictly before it
  const lastDecisionTime = (cutBars - 1) * FIFTEEN_MINUTES_MS;
  const decisionsBefore = (decisions: typeof full.result.decisions) =>
    decisions.filter((d) => d.timestamp < lastDecisionTime).map((d) => `${d.decisionId}|${d.status}`);
  assert.ok(decisionsBefore(partial.result.decisions).length > 0);
  assert.deepEqual(decisionsBefore(full.result.decisions), decisionsBefore(partial.result.decisions));
});
