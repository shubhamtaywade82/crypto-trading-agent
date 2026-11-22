import type { AgentId, Signal } from '../types.js';
import type { MarketState } from '../market/types.js';
import type { MicrostructureReading } from '../microstructure/MicrostructureEngine.js';

export interface ScoredSignal {
  signal: Signal;
  side: 'LONG' | 'SHORT';
  evidenceScore: number;
  factors: string[];
}

export interface TradeIntent {
  symbol: string;
  side: 'LONG' | 'SHORT';
  sourceAgent: AgentId;
  evidenceScore: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  reasons: string[];
}

function evaluateFactors(side: 'LONG' | 'SHORT', signal: Signal, state?: MarketState, micro?: MicrostructureReading): { bonus: number; factors: string[] } {
  let bonus = 0;
  const factors: string[] = [];

  if (state) {
    const isRegimeAligned =
      (side === 'LONG' && state.regime.regime === 'TREND_UP') ||
      (side === 'SHORT' && state.regime.regime === 'TREND_DOWN') ||
      (signal.agent === 'MEAN-REVERT-θ' && state.regime.regime === 'RANGE');
    if (isRegimeAligned) {
      bonus += 20;
      factors.push('regime_aligned:+20');
    }

    const isLocationGood = (side === 'LONG' && state.pricing.discount) || (side === 'SHORT' && state.pricing.premium);
    if (isLocationGood) {
      bonus += 20;
      factors.push('pricing_location:+20');
    }

    const hasSweep = state.liquidity.ltf.latestSweeps.some((s) =>
      side === 'LONG' ? s.direction === 'SELL_SIDE' : s.direction === 'BUY_SIDE'
    );
    if (hasSweep) {
      bonus += 10;
      factors.push('liquidity_sweep:+10');
    }

    if (state.crowding) {
      const isContrarian =
        (side === 'LONG' && (state.crowding.positioningExtreme === 'SHORT_CROWDED' || state.crowding.squeezeRisk === 'SHORT_SQUEEZE_RISK')) ||
        (side === 'SHORT' && (state.crowding.positioningExtreme === 'LONG_CROWDED' || state.crowding.squeezeRisk === 'LONG_SQUEEZE_RISK'));
      if (isContrarian) {
        bonus += 10;
        factors.push('crowding_squeeze:+10');
      }
    }
  }

  if (micro && micro.book.status === 'LIVE') {
    const imb = micro.depthImbalance?.bps10 ?? micro.depthImbalance?.bps25;
    if (imb !== null && imb !== undefined && ((side === 'LONG' && imb >= 0.15) || (side === 'SHORT' && imb <= -0.15))) {
      bonus += 10;
      factors.push('orderbook_imbalance:+10');
    }
    if (micro.bias.bias !== 'NEUTRAL') {
      if ((side === 'LONG' && micro.bias.bias === 'LONG') || (side === 'SHORT' && micro.bias.bias === 'SHORT')) {
        bonus += 10;
        factors.push('micro_bias_aligned:+10');
      } else if (micro.bias.bias !== side) {
        bonus -= 15;
        factors.push('micro_bias_opposing:-15');
      }
    }
    if (micro.events.some((e) => e.kind === 'ABSORPTION' && e.side === (side === 'LONG' ? 'bid' : 'ask'))) {
      bonus += 10;
      factors.push('wall_absorption:+10');
    }
    if ((side === 'LONG' && micro.liquidations?.exhaustion === 'LONG_EXHAUSTION') || (side === 'SHORT' && micro.liquidations?.exhaustion === 'SHORT_EXHAUSTION')) {
      bonus += 10;
      factors.push('liquidation_exhaustion:+10');
    }
  }

  return { bonus, factors };
}

function scoreSignal(signal: Signal, state?: MarketState, micro?: MicrostructureReading): ScoredSignal {
  const isShort = signal.type === 'OPEN_SHORT' || signal.type === 'OPEN_HEDGE' || signal.type === 'OPEN_FUNDING_SHORT';
  const side: 'LONG' | 'SHORT' = isShort ? 'SHORT' : 'LONG';
  const baseScore = Math.round(signal.confidence * 40);
  const { bonus, factors } = evaluateFactors(side, signal, state, micro);

  return {
    signal,
    side,
    evidenceScore: Math.min(100, Math.max(0, baseScore + bonus)),
    factors: [`base:${baseScore}`, ...factors],
  };
}

function pickWinner(bestLong?: ScoredSignal, bestShort?: ScoredSignal): ScoredSignal | null {
  if (!bestLong || !bestShort) return bestLong ?? bestShort ?? null;
  const diff = bestLong.evidenceScore - bestShort.evidenceScore;
  // Conflict threshold: if long and short have similar strength (<15 diff), stand down to avoid whipsaw
  if (Math.abs(diff) < 15) return null;
  return diff > 0 ? bestLong : bestShort;
}

function resolveSymbol(scoredList: ScoredSignal[]): TradeIntent | null {
  if (scoredList.length === 0) return null;
  const longs = scoredList.filter((s) => s.side === 'LONG').sort((a, b) => b.evidenceScore - a.evidenceScore);
  const shorts = scoredList.filter((s) => s.side === 'SHORT').sort((a, b) => b.evidenceScore - a.evidenceScore);

  const winner = pickWinner(longs[0], shorts[0]);
  if (!winner || winner.evidenceScore < 50) return null;

  const sig = winner.signal;
  if (!sig.entry || !sig.stopLoss || !sig.takeProfit) return null;

  return {
    symbol: sig.symbol,
    side: winner.side,
    sourceAgent: sig.agent,
    evidenceScore: winner.evidenceScore,
    entry: sig.entry,
    stopLoss: sig.stopLoss,
    takeProfit: sig.takeProfit,
    reasons: [...winner.factors, sig.reason],
  };
}

/** Combines multi-strategy candidate signals into a unified, conflict-free TradeIntent per symbol. */
export function fuseSignals(
  candidates: Signal[],
  marketStates?: Record<string, MarketState>,
  microstructure?: Record<string, MicrostructureReading>,
): TradeIntent[] {
  const bySymbol = new Map<string, Signal[]>();
  for (const sig of candidates) {
    if (!sig.type.startsWith('OPEN_')) continue;
    const list = bySymbol.get(sig.symbol) ?? [];
    list.push(sig);
    bySymbol.set(sig.symbol, list);
  }

  const intents: TradeIntent[] = [];
  for (const [symbol, sigs] of bySymbol.entries()) {
    const scored = sigs.map((sig) => scoreSignal(sig, marketStates?.[symbol], microstructure?.[symbol]));
    const intent = resolveSymbol(scored);
    if (intent) intents.push(intent);
  }
  return intents;
}
