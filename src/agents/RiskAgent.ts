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
    const leverage = Math.min(cappedSize / (riskBudget / slDistancePct), config.risk.maxLeverage);

    return this.checkBuffer(signal, ctx, cappedSize, leverage);
  }

  private checkBuffer(
    signal: Signal,
    ctx: MarketContext,
    cappedSize: number,
    leverage: number
  ): RiskDecision {
    const candles = ctx.candles[signal.symbol];
    if (!candles?.length) {
      return this.reject('insufficient candle history');
    }

    const atr14 = atr(candles, 14);
    if (atr14 <= 0) {
      return this.reject('invalid ATR calculation');
    }

    const buffer = Math.abs(signal.entry! - signal.stopLoss!) / atr14;
    if (buffer < config.risk.minLiqBufferAtr) {
      return this.reject(`liq buffer ${buffer.toFixed(1)}x ATR < ${config.risk.minLiqBufferAtr}x`);
    }

    return {
      approved: true,
      positionSizeUsdt: cappedSize,
      leverage,
      marginType: 'ISOLATED',
      liqBufferAtr: buffer,
      reason: `size=$${cappedSize.toFixed(0)} lev=${leverage.toFixed(1)}x buffer=${buffer.toFixed(1)}xATR`,
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
