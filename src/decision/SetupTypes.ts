import type { TrendDirection, VolatilityRegime } from '../market/types.js';

export type SetupDirection = 'LONG' | 'SHORT';
export type SetupKind = 'BREAKOUT_RETEST' | 'PULLBACK_RETEST' | 'LIQUIDITY_SWEEP';
/**
 * FORMING: structure/liquidity identified, level not yet taken/retested.
 * ARMED: level taken (or zone retested / sweep reclaimed) but the lower-timeframe
 * confirming break has not printed yet — one confirmation candle from TRIGGERED.
 * TRIGGERED: confirming break printed in the setup's direction. INVALIDATED is a
 * terminal state scenarios pass through but are never returned in (dead setups
 * are dropped, not surfaced). NO_TRADE is map-level only: no admissible scenario.
 */
export type SetupState = 'FORMING' | 'ARMED' | 'TRIGGERED' | 'INVALIDATED' | 'NO_TRADE';

export interface ExpectedMoveWindow {
  minMinutes: number;
  maxMinutes: number;
  thesisExpiryMinutes: number;
  distanceAtr: number;
}

export interface SetupScenario {
  id: string;
  kind: SetupKind;
  direction: SetupDirection;
  state: Exclude<SetupState, 'NO_TRADE' | 'INVALIDATED'>;
  timeframe: '15m' | '1h' | '4h';
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  trigger: string;
  invalidation: string;
  flowHypothesis: string;
  expectedMove: ExpectedMoveWindow;
  sourceTime: number;
  rewardRisk: number;
}

export interface SetupMap {
  symbol: string;
  generatedAt: number;
  mark: number;
  state: SetupState;
  bias: TrendDirection;
  regime: string;
  volatility: VolatilityRegime;
  positionPct: number;
  location: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  htfTrend: TrendDirection;
  ltfTrend: TrendDirection;
  lastBreak: {
    type: 'BOS' | 'CHOCH';
    direction: TrendDirection;
    level: number;
    time: number;
    distanceAtr: number;
  } | null;
  nearestUpperLiquidity: number | null;
  nearestLowerLiquidity: number | null;
  crowding: string | null;
  openInterestExpansion: boolean | null;
  takerAggressionRatio: number | null;
  scenarios: SetupScenario[];
  noTradeReasons: string[];
}
