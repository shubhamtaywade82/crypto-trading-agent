import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY } from '../ops/liveReadiness.js';

/** The evidence a strategy was approved on, frozen at approval time so a later review can see what justified it. */
export interface EvidenceSnapshot {
  trades: number;
  meanNetR: number;
  lcbNetR: number;
  firstHalfNetR: number;
  secondHalfNetR: number;
  forwardTrades: number;
  forwardMeanNetR: number;
}

export interface StrategyApproval {
  strategy: string;
  approvedAt: number;
  evidence: EvidenceSnapshot;
}

export interface ApprovalsFile {
  version: 1;
  generatedAt: number;
  approvals: StrategyApproval[];
}

const isFile = (value: unknown): value is ApprovalsFile => {
  const v = value as Partial<ApprovalsFile> | null;
  return v !== null && typeof v === 'object' && v.version === 1 && Array.isArray(v.approvals);
};

/** Re-checks the frozen evidence on load, so a hand-edited approvals file cannot list a strategy that never passed. */
export function evidencePasses(e: Partial<EvidenceSnapshot> | undefined): boolean {
  if (!e) return false;
  const { evidence, forward } = DEFAULT_POLICY;
  return (e.trades ?? 0) >= evidence.minTrades && (e.lcbNetR ?? 0) > 0
    && (e.firstHalfNetR ?? 0) > 0 && (e.secondHalfNetR ?? 0) > 0
    && (e.forwardTrades ?? 0) >= forward.minTrades && (e.forwardMeanNetR ?? 0) > 0;
}

/**
 * Strategies allowed to trade live. A missing, unreadable or malformed file approves nothing: the safe failure
 * for a live gate is to trade nothing, never to fall back to "everything".
 */
export function loadApprovals(file: string): ReadonlySet<string> {
  if (!file || !existsSync(file)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isFile(parsed)) return new Set();
    const valid = parsed.approvals.filter((a) => typeof a.strategy === 'string' && a.strategy.length > 0 && evidencePasses(a.evidence));
    return new Set(valid.map((a) => a.strategy));
  } catch {
    return new Set();
  }
}

export function writeApprovals(file: string, approvals: readonly StrategyApproval[], now = Date.now()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const body: ApprovalsFile = { version: 1, generatedAt: now, approvals: [...approvals] };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, file);
}
