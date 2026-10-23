import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision, Position } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import { config } from '../config.js';
import type { KillSwitch } from '../ops/killSwitch.js';
import { atr } from '../binance/indicators.js';
import { getSymbolRules } from '../binance/symbolRules.js';
import { contractSpecFor } from '../risk/contractSpec.js';
import type { PerformanceSnapshot } from '../risk/performanceEngine.js';
import { sizePosition, type SizingResult } from '../risk/positionSizer.js';
import { circuitRiskMultiplier, clusterOf, riskLimitsFromConfig, type RiskLimits } from '../risk/riskConfig.js';
import { evaluateRisk, openRiskOf, type PortfolioView } from '../risk/riskEngine.js';
import { isolatedLiquidationPrice, safestLeverage } from '../risk/liquidation.js';
import { combinedSizeMultiplier, type SizeScaling } from '../risk/sizeMultipliers.js';
import type { PeakEquitySource } from '../risk/equityHwm.js';
import { costAdjustedRr, minRrFor, type RrProfile } from '../risk/rrProfile.js';

export interface RiskAgentOptions {
  /** Defaults to the limits derived from `config.risk` at call time. */
  limits?: RiskLimits;
  /** When halted, every entry is refused; exits never pass through this agent. */
  killSwitch?: Pick<KillSwitch, 'state'>;
  /** Persistent equity high-water mark; when absent the agent tracks a session-local peak. */
  hwm?: PeakEquitySource;
  /** Calibrated per-strategy RR floors; when present the RR check uses cost-adjusted RR against the strategy's floor. */
  rrProfile?: RrProfile;
  /** Live gate: when set, OPEN signals from strategies outside `approvedStrategies` are refused. */
  requireApproval?: boolean;
  approvedStrategies?: ReadonlySet<string>;
  /** Defaults to the SIZE_VOL_SCALING / SIZE_SCORE_SCALING config. */
  sizeScaling?: SizeScaling;
}

export interface GateOptions {
  evidenceScore?: number;
}

// Strategies place stops in multiples of the state layer's closed-candle ATR; the gate must measure with the same ruler,
// and float noise must not turn a stop at exactly N ATR into "N-0.0001 < N".
const STOP_WIDTH_TOLERANCE = 0.01;

const NO_PERFORMANCE = 'risk-engine: performance snapshot unavailable';
/** A delta-neutral pair needs a spot leg and its own risk model; neither exists, so a perp-only short is refused, never sized. */
const FUNDING_HARVEST_REFUSED = 'funding harvest needs a delta-neutral leg (spot long + perp short), which is not implemented; refused';

const isShort = (signal: Signal): boolean => signal.type === 'OPEN_SHORT';
const notionalOf = (positions: Position[]): number => positions.reduce((sum, p) => sum + p.qty * p.mark, 0);

/** Long stops must sit below entry and short stops above it; the sizer measures distance only, so a wrong-side stop would size a trade that is not protected. */
function isStopOnWrongSide(signal: Signal): boolean {
  return isShort(signal) ? signal.stopLoss! <= signal.entry! : signal.stopLoss! >= signal.entry!;
}

function rewardRisk(signal: Signal): number | undefined {
  if (signal.takeProfit === undefined) return undefined;
  return Math.abs(signal.takeProfit - signal.entry!) / Math.abs(signal.entry! - signal.stopLoss!);
}

// Isolated margin per position is notional / leverage; positions absent from ctx are treated as using none
function availableMargin(ctx: MarketContext): number {
  const inUse = (ctx.positions ?? []).reduce((sum, p) => sum + (p.qty * p.mark) / Math.max(1, p.leverage), 0);
  return Math.max(0, ctx.equity - inUse);
}

function portfolioView(ctx: MarketContext, performance: PerformanceSnapshot): PortfolioView {
  const positions = ctx.positions ?? [];
  return {
    equity: ctx.equity,
    openPositions: positions.length,
    grossExposure: notionalOf(positions),
    symbolExposure: (symbol) => notionalOf(positions.filter((p) => p.symbol === symbol)),
    clusterExposure: (cluster) => notionalOf(positions.filter((p) => clusterOf(p.symbol) === cluster)),
    performance,
    openRisk: openRiskOf(positions),
  };
}

/**
 * Gating authority. Every OPEN signal MUST pass this agent.
 * Deterministic formulas, no LLM involvement. There is one sizing path: the risk engine.
 */
export class RiskAgent extends BaseAgent {
  readonly id = 'RISK-MGR-δ' as const;
  readonly strategy = 'risk_gate_isolated';
  status = 'WATCHING' as const;

  constructor(svc: BinanceService, private readonly options: RiskAgentOptions = {}) {
    super(svc);
  }

  protected async analyze(_ctx: MarketContext): Promise<Signal[]> {
    return [];
  }

  /** `evidenceScore` is the 0-100 score the entry was taken on; it only shrinks the size (see sizeMultipliers). */
  gate(signal: Signal, ctx: MarketContext, opts: GateOptions = {}): RiskDecision {
    if (this.options.requireApproval && signal.type.startsWith('OPEN_') && !this.options.approvedStrategies?.has(signal.agent)) {
      return this.reject(`strategy ${signal.agent} is not approved for live trading`);
    }
    const halt = this.options.killSwitch?.state();
    if (!halt?.halted || !signal.type.startsWith('OPEN_')) return this.gateSafety(signal, ctx, opts);
    this.isDrawdownBreached(ctx); // only to keep the session equity peak tracking while halted
    return this.reject(`kill-switch: ${halt.reason}`);
  }

  /** Priority-0 market safety (stale feed, bad mark, exchange status, shock) blocks new entries only. */
  private gateSafety(signal: Signal, ctx: MarketContext, opts: GateOptions): RiskDecision {
    const verdict = signal.type.startsWith('OPEN_') ? ctx.safety?.[signal.symbol] : undefined;
    if (verdict && verdict.level !== 'NORMAL') return this.reject(`safety ${verdict.level}: ${verdict.reasons.join('; ')}`);
    return this.gateEntry(signal, ctx, opts);
  }

  private gateEntry(signal: Signal, ctx: MarketContext, opts: GateOptions): RiskDecision {
    if (this.isDrawdownBreached(ctx)) {
      return this.reject(`drawdown kill-switch: current drawdown exceeds ${config.risk.maxDrawdownPct}%`);
    }
    if (signal.type === 'OPEN_HEDGE' || signal.type === 'OPEN_FUNDING_SHORT') return this.reject(FUNDING_HARVEST_REFUSED);
    if (!signal.stopLoss || !signal.entry) return this.reject('missing entry/SL');
    if (Math.abs(signal.entry - signal.stopLoss) / signal.entry === 0) return this.reject('stop loss matches entry');
    if (isStopOnWrongSide(signal)) return this.reject('stop on wrong side of entry');
    return this.evaluateWithEngine(signal, ctx, opts);
  }

  private evaluateWithEngine(signal: Signal, ctx: MarketContext, opts: GateOptions): RiskDecision {
    if (!ctx.performance) return this.reject(NO_PERFORMANCE);
    const tiers = ctx.maintenance?.[signal.symbol];
    if (!tiers || tiers.length === 0) {
      return this.reject(`maintenance brackets for ${signal.symbol} not loaded; entries refused until the venue answers`);
    }
    const candles = ctx.candles[signal.symbol] ?? ctx.candles[signal.symbol.split('/')[0]] ?? ctx.candles[`${signal.symbol.split('/')[0]}USDT`];
    if (!candles?.length) return this.reject('insufficient candle history');
    // Same ATR the strategies used (closed 15m candles); ctx.candles still carries the forming candle, which understates it
    const stateAtr = ctx.marketState?.[signal.symbol]?.timeframes['15m'].atr14;
    const atr14 = stateAtr !== undefined && stateAtr !== null && stateAtr > 0 ? stateAtr : atr(candles, 14);
    if (!(atr14 > 0)) return this.reject('invalid ATR calculation');

    const entry = signal.entry!;
    const stop = signal.stopLoss!;
    const stopWidth = Math.abs(entry - stop) / atr14;
    if (stopWidth * (1 + STOP_WIDTH_TOLERANCE) < config.risk.minStopAtr) {
      return this.reject(`stop ${stopWidth.toFixed(1)}x ATR < ${config.risk.minStopAtr}x`);
    }

    const baseLimits = this.limits();
    const profile = this.options.rrProfile;
    const limits = profile
      ? { ...baseLimits, minRiskRewardRatio: minRrFor(profile, signal.agent, baseLimits.minRiskRewardRatio) }
      : baseLimits;
    const side = isShort(signal) ? 'SHORT' : 'LONG';
    const sizeMultiplier = combinedSizeMultiplier(
      this.options.sizeScaling ?? { volatility: config.sizing.volatilityScaling, score: config.sizing.scoreScaling },
      { atrPercentile: ctx.marketState?.[signal.symbol]?.regime?.volatilityPercentile ?? undefined, evidenceScore: opts.evidenceScore },
    );
    const size = (requestedLeverage: number): SizingResult => sizePosition({
      equity: ctx.equity,
      availableMargin: availableMargin(ctx),
      direction: side,
      entry,
      stop,
      requestedLeverage,
      fundingRate: ctx.funding[signal.symbol],
      spec: contractSpecFor(signal.symbol, getSymbolRules(signal.symbol), limits),
      limits,
      circuitMultiplier: circuitRiskMultiplier(ctx.performance!.circuit),
      riskMultiplier: sizeMultiplier,
    });

    let sizing = size(this.calculateDynamicLeverage(signal.confidence, Math.abs(entry - stop) / entry, stopWidth));
    if (sizing.ok) {
      // Quantity is set by the risk budget, not by leverage, so the search moves only the liquidation price and the margin
      const safe = safestLeverage({
        side, entry, stop, qty: sizing.quantity, atr: atr14, clearanceAtr: config.risk.minLiqBufferAtr,
        requestedLeverage: sizing.leverage, minLeverage: limits.minLeverage, maxLeverage: limits.maxLeverage, tiers,
      });
      if (!safe) return this.reject(`liquidation sits inside the stop at every leverage from ${limits.minLeverage}x to ${sizing.leverage}x`);
      if (safe.leverage < sizing.leverage) sizing = size(safe.leverage);
    }

    const rr = profile && signal.takeProfit !== undefined
      ? costAdjustedRr({ entry, stopLoss: stop, takeProfit: signal.takeProfit, side }, { feeRate: limits.feeRateTaker, slippageRate: limits.slippageBufferRate })
      : rewardRisk(signal);
    const verdict = evaluateRisk({ symbol: signal.symbol, sizing, portfolio: portfolioView(ctx, ctx.performance.snapshot), limits, rr });
    if (!verdict.approved) return this.reject(`risk-engine: ${verdict.reasons.join('; ')}`);

    const liquidation = sizing.ok ? isolatedLiquidationPrice({ side, entry, qty: sizing.quantity, leverage: sizing.leverage, tiers }) : null;
    const clearance = liquidation === null ? 0 : Math.abs(stop - liquidation) / atr14;
    return {
      approved: true,
      positionSizeUsdt: sizing.notional,
      leverage: sizing.leverage,
      marginType: 'ISOLATED',
      liqBufferAtr: clearance,
      reason: `qty ${sizing.quantity} notional $${sizing.notional.toFixed(0)} lev ${sizing.leverage}x liq ${liquidation?.toFixed(2) ?? 'n/a'} clear ${clearance.toFixed(1)}xATR circuit ${verdict.circuit}${sizeMultiplier < 1 ? ` size×${sizeMultiplier.toFixed(2)}` : ''}`,
    };
  }

  private limits(): RiskLimits {
    return this.options.limits ?? riskLimitsFromConfig();
  }

  /**
   * Drawdown kill-switch (issue #10). Compares current equity against the account's high-water mark; if the drawdown
   * from peak exceeds MAX_DRAWDOWN_PCT, all OPEN signals are rejected until the account recovers. Closes still pass.
   *
   * The peak is the persisted EquityHwmStore when one is injected (survives restarts); without one, the agent tracks
   * the peak in-process only.
   */
  private peakEquity = 0;
  private isDrawdownBreached(ctx: MarketContext): boolean {
    if (ctx.equity <= 0) return true;
    const peak = this.options.hwm
      ? this.options.hwm.observe(ctx.equity)
      : (this.peakEquity = Math.max(this.peakEquity, ctx.equity));
    const drawdownPct = ((peak - ctx.equity) / peak) * 100;
    return drawdownPct > config.risk.maxDrawdownPct;
  }

  private calculateDynamicLeverage(confidence: number, slDistancePct: number, atrBuffer: number): number {
    const minLev = config.risk.minLeverage;
    const maxLev = config.risk.maxLeverage;
    const confFactor = Math.max(0, Math.min(1, (confidence - 0.5) / 0.5));
    const slFactor = Math.max(0, Math.min(1, 0.03 / Math.max(0.008, slDistancePct)));
    const bufferFactor = Math.max(0, Math.min(1, (atrBuffer - 1.5) / 2));
    const score = 0.5 * confFactor + 0.3 * slFactor + 0.2 * bufferFactor;
    const raw = minLev + score * (maxLev - minLev);
    return Math.round(Math.max(minLev, Math.min(maxLev, raw)));
  }

  private reject(reason: string): RiskDecision {
    return {
      approved: false,
      positionSizeUsdt: 0,
      leverage: 0,
      marginType: 'ISOLATED',
      liqBufferAtr: 0,
      reason,
    };
  }
}
