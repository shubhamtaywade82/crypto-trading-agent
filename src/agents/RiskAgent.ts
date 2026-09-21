import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision } from '../types.js';
import { config } from '../config.js';
import { atr } from '../binance/indicators.js';

/**
 * Gating authority. Every OPEN signal MUST pass this agent.
 * Deterministic formulas, no LLM involvement.
 */
export class RiskAgent extends BaseAgent {
  readonly id = 'RISK-MGR-δ' as const;
  readonly strategy = 'liquidation_guard_isolated';
  status = 'WATCHING' as const;

  protected async analyze(_ctx: MarketContext): Promise<Signal[]> {
    return [];
  }

  gate(signal: Signal, ctx: MarketContext): RiskDecision {
    const equity = ctx.equity;
    const maxNotional = equity * (config.risk.maxExposurePct / 100);
    const riskBudget = equity * (config.risk.riskPerTradePct / 100);

    // Issue #10: MAX_DRAWDOWN_PCT was previously a display-only metric.
    // Now it's a kill-switch — once drawdown exceeds the limit, no new OPEN
    // signals are approved until the account recovers. Closes (reduceOnly
    // and opposite-side exits) still pass through, since reducing exposure
    // is the correct response to a drawdown breach.
    if (this.isDrawdownBreached(ctx)) {
      return this.reject(`drawdown kill-switch: current drawdown exceeds ${config.risk.maxDrawdownPct}%`);
    }

    // Funding harvest positions in futures
    if (signal.type === 'OPEN_HEDGE') {
      const leverage = config.risk.minLeverage;
      return {
        approved: true,
        positionSizeUsdt: Math.min(signal.notionalUsdt ?? riskBudget, maxNotional),
        leverage,
        marginType: 'ISOLATED',
        liqBufferAtr: Infinity,
        reason: `funding harvest ${leverage}x isolated`,
      };
    }

    if (!signal.stopLoss || !signal.entry) {
      return this.reject('missing entry/SL');
    }

    const slDistancePct = Math.abs(signal.entry - signal.stopLoss) / signal.entry;
    if (slDistancePct === 0) {
      return this.reject('stop loss matches entry');
    }

    const positionSizeUsdt = riskBudget / slDistancePct;
    const cappedSize = Math.min(positionSizeUsdt, maxNotional);
    return this.checkBuffer(signal, ctx, cappedSize, slDistancePct);
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
