import type { z } from 'zod';
import type { Direction, StrategySignal } from '../domain/strategy.js';

/** Parses and freezes a strategy's parameters; unknown keys are rejected so a typo cannot silently run on a default. */
export function parseParameters<S extends z.ZodTypeAny>(strategyId: string, schema: S, raw: unknown): Readonly<z.infer<S>> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`strategy "${strategyId}" parameters: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return Object.freeze(parsed.data);
}

export interface BracketInput {
  readonly direction: Direction;
  readonly entry: number;
  readonly atr: number;
  readonly stopAtr: number;
  readonly targetAtr: number;
}

/** Stop and target at ATR multiples either side of the entry. */
export function atrBracket({ direction, entry, atr, stopAtr, targetAtr }: BracketInput): Pick<StrategySignal, 'entry' | 'stopLoss' | 'takeProfit'> {
  const sign = direction === 'LONG' ? 1 : -1;
  return { entry, stopLoss: entry - sign * atr * stopAtr, takeProfit: entry + sign * atr * targetAtr };
}
