/**
 * One-shot Tev1 decision-intelligence evaluation: run a candidate through the full
 * decision layer (snapshot -> /v1/systemone -> evaluator -> deterministic policy -> audit)
 * and print everything an operator needs to judge the layer itself.
 *
 *   npm run tev1:eval -- [--demo] [--live --symbol SOLUSDT] [--side LONG]
 *                        [--model tev1:4b] [--mode shadow] [--host http://127.0.0.1:11434]
 *
 * --demo (default): a clearly synthetic SOLUSDT candidate — validates wiring, fail-closed
 *   behavior and the audit trail without touching Binance. With no Ollama reachable, the
 *   run demonstrates the enforced-mode non-approval instead of erroring out.
 * --live: fetches a real MarketState from Binance public endpoints and derives a
 *   demonstration candidate from the live mark and 15m ATR (labelled as such; it is NOT a
 *   strategy signal) so the snapshot builder runs against genuine market facts.
 *
 * No API keys, no orders. Audit rows are appended to TEV1_AUDIT_PATH (default
 * data/tev1-decisions.jsonl) so every run remains replayable.
 */
import { config } from '../src/config.js';
import { HttpTev1Client } from '../src/decision-intelligence/clients/tev1Client.js';
import { DecisionIntelligenceService } from '../src/decision-intelligence/services/decisionOrchestrator.js';
import { DecisionAuditRepository } from '../src/decision-intelligence/repositories/decisionAuditRepository.js';
import { buildDecisionSnapshot } from '../src/decision-intelligence/snapshots/decisionSnapshotBuilder.js';
import { demoMarketState } from '../src/decision-intelligence/demo/demoState.js';
import type { MarketState } from '../src/market/types.js';
import type { Signal } from '../src/types.js';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const SYMBOL = (arg('symbol') ?? 'SOLUSDT').toUpperCase();
const SIDE: 'LONG' | 'SHORT' = (arg('side') ?? 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
const MODEL = arg('model') ?? config.tev1.model;
const MODE = (arg('mode') ?? 'on') as 'on' | 'shadow';
const HOST = arg('host') ?? config.ollama.host;
const LIVE = has('live');

function banner(title: string): void {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

/** The synthetic demo candidate: labeled as such everywhere it appears. */
function demoSignal(now: number): Signal {
  const entry = 101.72;
  const stop = 100.96;
  const target = 103.4;
  return {
    id: `tev1-demo-${now}`,
    agent: 'STRUCTURE-TREND-η',
    symbol: 'SOLUSDT',
    type: SIDE === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
    confidence: 0.72,
    ...(SIDE === 'LONG' ? { entry, stopLoss: stop, takeProfit: target } : { entry, stopLoss: 102.41, takeProfit: 100.56 }),
    reason: `DEMO CANDIDATE (synthetic): 4h bullish BOS with 1h continuation, 15m reclaim retest, RR 2.21 ${SIDE}`,
    ts: now,
  };
}

/** Live market state via the same public-endpoint path as scripts/inspect-state.ts. */
async function liveState(symbol: string): Promise<{ state: MarketState; mark: number } | null> {
  const { BinanceService } = await import('../src/binance/client.js');
  const { MarketStateBuilder } = await import('../src/market/MarketStateBuilder.js');
  const binance = new BinanceService();
  await binance.initVenue();
  const market = await binance.getMarketOverview([symbol]);
  const builder = new MarketStateBuilder();
  const states = builder.buildAll([{
    symbol,
    candles: market.candles[symbol] ?? [],
    candlesByTimeframe: market.marketDataV2?.[symbol]?.candles,
    derivatives: market.marketDataV2?.[symbol]?.derivatives,
    mark: market.marks[symbol] ?? 0,
    fundingRate: market.funding[symbol] ?? 0,
  }]);
  const state = states[symbol];
  if (!state) return null;
  return { state, mark: market.marks[symbol] ?? state.mark };
}

/** A demonstration candidate derived from the live mark and 15m ATR — NOT a strategy signal. */
function liveSignal(symbol: string, mark: number, atr: number, now: number): Signal {
  const stopDistance = 2 * atr;
  const targetDistance = 3 * atr;
  const round = (value: number) => Number(value.toFixed(Math.max(2, Math.ceil(-Math.log10(atr)) + 1)));
  return {
    id: `tev1-live-${now}`,
    agent: 'STRUCTURE-TREND-η',
    symbol,
    type: SIDE === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
    confidence: 0.7,
    entry: round(mark),
    stopLoss: round(SIDE === 'LONG' ? mark - stopDistance : mark + stopDistance),
    takeProfit: round(SIDE === 'LONG' ? mark + targetDistance : mark - targetDistance),
    reason: `DEMONSTRATION candidate (not a strategy signal): ${SIDE} at mark, stop 2xATR15m, target 3xATR15m`,
    ts: now,
  };
}

async function main(): Promise<void> {
  const now = Date.now();
  console.log(`Tev1 decision-intelligence evaluation — model ${MODEL}, mode ${MODE}, host ${HOST}`);
  if (MODE === 'on') console.log('note: enforced mode — a BLOCK verdict here would refuse the candidate in the live loop');

  let signal: Signal;
  let state: MarketState | undefined;
  if (LIVE) {
    banner(`live market state: ${SYMBOL}`);
    console.log(`fetching ${SYMBOL} from Binance public endpoints...`);
    const live = await liveState(SYMBOL);
    if (!live) {
      console.error(`no market state could be built for ${SYMBOL} (is the symbol traded?)`);
      process.exit(1);
    }
    state = live.state;
    const atr = state.timeframes['15m'].atr14 ?? Math.max(0.01, live.mark * 0.004);
    signal = liveSignal(SYMBOL, live.mark, atr, now);
    console.log(`mark ${live.mark}, regime ${state.regime.regime} (${state.regime.trendDirection}), 15m ATR ${atr.toFixed(4)}`);
  } else {
    banner('synthetic demo candidate');
    signal = demoSignal(now);
    state = demoMarketState(now);
    console.log('DEMO: synthetic SOLUSDT state (src/decision-intelligence/demo/demoState.ts), clearly labeled —');
    console.log('      validates wiring and fail-closed behavior, not a trading recommendation.');
  }

  const evidence = { breakdown: null, score: 70, factors: ['demo evidence score'] };
  const snapshot = buildDecisionSnapshot({ signal, state, evidence, now });
  if (snapshot === null) {
    console.error('the candidate has no complete entry/stop/target geometry; nothing to evaluate');
    process.exit(1);
  }

  banner('decision snapshot (the state payload)');
  console.log(JSON.stringify(snapshot, null, 2));

  banner('evaluation');
  const service = new DecisionIntelligenceService({
    mode: MODE,
    minConfidence: config.tev1.minConfidence,
    model: MODEL,
    client: new HttpTev1Client({ host: HOST, apiKey: config.ollama.apiKeys[0], timeoutMs: config.tev1.timeoutMs }),
    audit: new DecisionAuditRepository(config.tev1.auditPath),
    log: (message, level) => console.log(`[${level}] ${message}`),
  });
  const verdict = await service.evaluateCandidate({
    decisionId: `cli-${now}`,
    signal,
    state,
    evidence,
    now,
  });

  banner('verdict');
  console.log(`gate:        ${verdict.gate}`);
  console.log(`action:      ${verdict.action}`);
  console.log(`enforced:    ${verdict.enforced} (mode ${verdict.mode})`);
  console.log(`choice:      ${verdict.choice ?? 'n/a'}`);
  console.log(`confidence:  ${verdict.confidence !== null ? verdict.confidence.toFixed(2) : 'n/a'}`);
  console.log(`reason:      ${verdict.reason}`);
  console.log(`\nreminder: a classification probability is NOT the probability that the trade will be profitable.`);
  console.log(`audit row appended to ${config.tev1.auditPath} (replayable).`);
  if (!LIVE) console.log('\nnext: npm run tev1:eval -- --live --symbol SOLUSDT evaluates a real MarketState.');
}

main().catch((err) => {
  console.error(`[tev1-evaluate] ${(err as Error).message}`);
  process.exit(1);
});
