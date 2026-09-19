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

    // Delta-neutral hedges bypass directional risk calculation
    if (signal.type === 'OPEN_HEDGE') {
      return {
        approved: true,
        positionSizeUsdt: Math.min(signal.notionalUsdt ?? riskBudget, maxNotional),
        leverage: 1,
        marginType: 'ISOLATED',
        liqBufferAtr: Infinity,
        reason: 'delta-neutral hedge',
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
