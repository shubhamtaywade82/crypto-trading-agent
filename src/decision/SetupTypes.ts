import type { TrendDirection, VolatilityRegime } from '../market/types.js';

export type SetupDirection = 'LONG' | 'SHORT';
export type SetupKind = 'BREAKOUT_RETEST' | 'PULLBACK_RETEST' | 'LIQUIDITY_SWEEP';
export type SetupState = 'WATCHING' | 'TRIGGERED' | 'NO_TRADE';

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
  state: Exclude<SetupState, 'NO_TRADE'>;
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
