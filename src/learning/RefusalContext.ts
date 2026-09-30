import type { DecisionRecord } from '../decision/DecisionJournal.js';
import { classifyRiskRefusal } from '../decision/NoTrade.js';

export interface CapacityContext {
  strategy: string;
  /** Capacity refusals for this strategy. */
  refused: number;
  /** Of those, how many arrived while an executed position on the same symbol was still open. */
  whileSymbolHeld: number;
  /** Which limit the refusal text named (a refusal can name several). */
  limits: Record<'symbol' | 'gross' | 'cluster' | 'notional' | 'position_count' | 'legacy_gross' | 'other', number>;
}

const heldAt = (executed: readonly DecisionRecord[], symbol: string, at: number): boolean =>
  executed.some((e) => e.symbol === symbol && e.timestamp <= at && (e.outcome?.closedAt ?? Number.POSITIVE_INFINITY) > at);

/**
 * Splits capacity refusals into "already positioned in this symbol" and everything else, and names the limit that was hit.
 * A strategy refused only while a same-symbol position is open is waiting its turn; one refused with nothing open is
 * being blocked by something else (a cap that an empty book already breaches, a circuit, a config mismatch).
 */
export function capacityContext(records: readonly DecisionRecord[]): CapacityContext[] {
  const executed = records.filter((r) => r.status === 'EXECUTED');
  const byStrategy = new Map<string, CapacityContext>();
  for (const r of records) {
    if (r.status !== 'RISK_REJECTED' || classifyRiskRefusal(r.rejectionReason ?? '') !== 'PORTFOLIO_CAPACITY') continue;
    const row = byStrategy.get(r.strategy) ?? {
      strategy: r.strategy, refused: 0, whileSymbolHeld: 0,
      limits: { symbol: 0, gross: 0, cluster: 0, notional: 0, position_count: 0, legacy_gross: 0, other: 0 },
    };
    row.refused += 1;
    if (heldAt(executed, r.symbol, r.timestamp)) row.whileSymbolHeld += 1;
    const text = r.rejectionReason ?? '';
    let named = false;
    const hit = (key: keyof CapacityContext['limits'], re: RegExp): void => { if (re.test(text)) { row.limits[key] += 1; named = true; } };
    hit('symbol', /\bsymbol [\d.]+%/);
    hit('gross', /\bgross [\d.]+%/);
    hit('cluster', /\bcluster \w+ [\d.]+%/);
    hit('notional', /\bnotional [\d.]+ \(max/);
    hit('position_count', /position_count|max concurrent positions/);
    hit('legacy_gross', /max gross exposure reached/);
    if (!named) row.limits.other += 1;
    byStrategy.set(r.strategy, row);
  }
  return [...byStrategy.values()].sort((a, b) => b.refused - a.refused);
}
