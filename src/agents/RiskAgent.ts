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
import { evaluateRisk, type PortfolioView } from '../risk/riskEngine.js';

export interface RiskAgentOptions {
  /** Defaults to `config.riskEngine`; injectable so tests never mutate process.env. */
  riskEngine?: 'on' | 'off';
  /** Defaults to the limits derived from `config.risk` at call time. */
  limits?: RiskLimits;
  /** When halted, every entry is refused whatever RISK_ENGINE says; exits never pass through this agent. */
  killSwitch?: Pick<KillSwitch, 'state'>;
}

const NO_PERFORMANCE = 'risk-engine: performance snapshot unavailable';

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
  };
}

// A hedge is sized by notional, not by stop distance, so it carries no per-unit risk
function hedgeSizing(notional: number, leverage: number): SizingResult {
  return {
    ok: true, quantity: 0, notional, marginRequired: notional / leverage, leverage, riskAmount: 0,
    effectiveRiskPerUnit: 0, feePerUnit: 0, fundingPerUnit: 0, warnings: [],
  };
}

/**
 * Gating authority. Every OPEN signal MUST pass this agent.
 * Deterministic formulas, no LLM involvement.
 */
export class RiskAgent extends BaseAgent {
  readonly id = 'RISK-MGR-δ' as const;
  readonly strategy = 'liquidation_guard_isolated';
  status = 'WATCHING' as const;

  constructor(svc: BinanceService, private readonly options: RiskAgentOptions = {}) {
    super(svc);
  }

  protected async analyze(_ctx: MarketContext): Promise<Signal[]> {
    return [];
  }

  gate(signal: Signal, ctx: MarketContext): RiskDecision {
    const halt = this.options.killSwitch?.state();
    if (!halt?.halted || !signal.type.startsWith('OPEN_')) return this.gateEntry(signal, ctx);
    this.isDrawdownBreached(ctx); // only to keep the session equity peak tracking while halted
    return this.reject(`kill-switch: ${halt.reason}`);
  }

  private gateEntry(signal: Signal, ctx: MarketContext): RiskDecision {
    const equity = ctx.equity;
    const maxNotional = equity * (config.risk.maxExposurePct / 100);
    const riskBudget = equity * (config.risk.riskPerTradePct / 100);

    if (this.isDrawdownBreached(ctx)) {
      return this.reject(`drawdown kill-switch: current drawdown exceeds ${config.risk.maxDrawdownPct}%`);
    }

    if (signal.type === 'OPEN_HEDGE') return this.gateHedge(signal, ctx, riskBudget, maxNotional);

    if (!signal.stopLoss || !signal.entry) {
      return this.reject('missing entry/SL');
    }

    const slDistancePct = Math.abs(signal.entry - signal.stopLoss) / signal.entry;
    if (slDistancePct === 0) {
      return this.reject('stop loss matches entry');
    }

    if (this.isEngineOn() && isStopOnWrongSide(signal)) {
      return this.reject('stop on wrong side of entry');
    }

    const positionSizeUsdt = riskBudget / slDistancePct;
    const cappedSize = Math.min(positionSizeUsdt, maxNotional);
    return this.checkBuffer(signal, ctx, cappedSize, slDistancePct);
  }

  // Funding harvest positions in futures
  private gateHedge(signal: Signal, ctx: MarketContext, riskBudget: number, maxNotional: number): RiskDecision {
    const leverage = config.risk.minLeverage;
    const harvest: RiskDecision = {
      approved: true,
      positionSizeUsdt: Math.min(signal.notionalUsdt ?? riskBudget, maxNotional),
      leverage,
      marginType: 'ISOLATED',
      liqBufferAtr: Infinity,
      reason: `funding harvest ${leverage}x isolated`,
    };
    return this.isEngineOn() ? this.vetoHedge(signal, ctx, harvest) : harvest;
  }

  private vetoHedge(signal: Signal, ctx: MarketContext, harvest: RiskDecision): RiskDecision {
    if (!ctx.performance) return this.reject(NO_PERFORMANCE);
    // A market-neutral hedge has no stop to derive reward:risk from, so that check cannot apply to it
    const limits = { ...this.limits(), minRiskRewardRatio: 0 };
    const verdict = evaluateRisk({
      symbol: signal.symbol,
      sizing: hedgeSizing(harvest.positionSizeUsdt, harvest.leverage),
      portfolio: portfolioView(ctx, ctx.performance.snapshot),
      limits,
    });
    return verdict.approved ? harvest : this.reject(`risk-engine: ${verdict.reasons.join('; ')}`);
  }

  private isEngineOn(): boolean {
    return (this.options.riskEngine ?? config.riskEngine) === 'on';
  }

  private limits(): RiskLimits {
    return this.options.limits ?? riskLimitsFromConfig();
  }

  private evaluateWithEngine(signal: Signal, ctx: MarketContext, leverage: number, liqBufferAtr: number): RiskDecision {
    if (!ctx.performance) return this.reject(NO_PERFORMANCE);
    const limits = this.limits();
    const sizing = sizePosition({
      equity: ctx.equity,
      availableMargin: availableMargin(ctx),
      direction: isShort(signal) ? 'SHORT' : 'LONG',
      entry: signal.entry!,
      stop: signal.stopLoss!,
      requestedLeverage: leverage,
      fundingRate: ctx.funding[signal.symbol],
      spec: contractSpecFor(signal.symbol, getSymbolRules(signal.symbol), limits),
      limits,
      circuitMultiplier: circuitRiskMultiplier(ctx.performance.circuit),
    });
    const portfolio = portfolioView(ctx, ctx.performance.snapshot);
    const verdict = evaluateRisk({ symbol: signal.symbol, sizing, portfolio, limits, rr: rewardRisk(signal) });
    if (!verdict.approved) return this.reject(`risk-engine: ${verdict.reasons.join('; ')}`);
    return {
      approved: true,
      positionSizeUsdt: sizing.notional,
      leverage: sizing.leverage,
      marginType: 'ISOLATED',
      liqBufferAtr,
      reason: `qty ${sizing.quantity} notional $${sizing.notional.toFixed(0)} lev ${sizing.leverage}x circuit ${verdict.circuit}`,
    };
  }

  /**
   * Drawdown kill-switch (issue #10). Compares current equity against the
   * peak equity observed this session; if the drawdown from peak exceeds
   * MAX_DRAWDOWN_PCT, all OPEN signals are rejected until the account
   * recovers. Closes still pass — reducing exposure is correct here.
   *
   * ponytail: tracks the peak in-process. A restart resets the peak, so a
   * process crash mid-drawdown is the one blind spot — for a paper broker
   * this is acceptable; for live trading the peak should live in the
   * broker's ledger (see paper_exchange issue #19 for the per-strategy
   * metadata migration that would close this gap).
   */
  private peakEquity = 0;
  private isDrawdownBreached(ctx: MarketContext): boolean {
    if (ctx.equity <= 0) return true;
    this.peakEquity = Math.max(this.peakEquity, ctx.equity);
    const drawdownPct = ((this.peakEquity - ctx.equity) / this.peakEquity) * 100;
    return drawdownPct > config.risk.maxDrawdownPct;
  }

  private calculateDynamicLeverage(
    confidence: number,
    slDistancePct: number,
    atrBuffer: number
  ): number {
    const minLev = config.risk.minLeverage;
    const maxLev = config.risk.maxLeverage;
    const confFactor = Math.max(0, Math.min(1, (confidence - 0.5) / 0.5));
    const slFactor = Math.max(0, Math.min(1, 0.03 / Math.max(0.008, slDistancePct)));
    const bufferFactor = Math.max(0, Math.min(1, (atrBuffer - 1.5) / 2));
    const score = 0.5 * confFactor + 0.3 * slFactor + 0.2 * bufferFactor;
    const raw = minLev + score * (maxLev - minLev);
    return Math.round(Math.max(minLev, Math.min(maxLev, raw)));
  }

  private checkBuffer(
    signal: Signal,
    ctx: MarketContext,
    cappedSize: number,
    slDistancePct: number
  ): RiskDecision {
    const baseSymbol = signal.symbol.split('/')[0];
    const candles = ctx.candles[signal.symbol] ?? ctx.candles[baseSymbol] ?? ctx.candles[`${baseSymbol}USDT`];
    if (!candles?.length) {
      return this.reject('insufficient candle history');
    }

    const atr14 = atr(candles, 14);
    if (atr14 <= 0) {
      return this.reject('invalid ATR calculation');
    }

    const atrDist = signal.symbol.includes('/') ? (signal.entry! * 0.015) : atr14;
    const buffer = Math.abs(signal.entry! - signal.stopLoss!) / atrDist;
    if (buffer < config.risk.minLiqBufferAtr) {
      return this.reject(`liq buffer ${buffer.toFixed(1)}x ATR < ${config.risk.minLiqBufferAtr}x`);
    }

    const leverage = this.calculateDynamicLeverage(signal.confidence, slDistancePct, buffer);
    if (this.isEngineOn()) return this.evaluateWithEngine(signal, ctx, leverage, buffer);
    return this.approveCapped(cappedSize, leverage, buffer);
  }

  private approveCapped(cappedSize: number, leverage: number, buffer: number): RiskDecision {
    return {
      approved: true,
      positionSizeUsdt: cappedSize,
      leverage,
      marginType: 'ISOLATED',
      liqBufferAtr: buffer,
      reason: `size=$${cappedSize.toFixed(0)} lev=${leverage}x buffer=${buffer.toFixed(1)}xATR`,
    };
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
