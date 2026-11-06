/**
 * Append-only ledger of untouched-test (OOS) reads, committed to git.
 *
 * Rule: for one spec id, a symbol x timeframe test window can be read under one spec hash only. Re-reading the same window
 * with the same hash is a replay (allowed, same answer). Reading an overlapping window with a changed hash is refused:
 * that would be tuning on the test set. Reads by different spec ids are allowed and are all counted, because every read
 * belongs to the family that multiple-testing correction must cover.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface OosRead {
  specId: string;
  specVersion: number;
  specHash: string;
  symbol: string;
  timeframe: string;
  testFromIso: string;
  testToIso: string;
  readAtIso: string;
  runId: string;
  /** Set for campaign specs, so a campaign's registration budget counts reads even after a spec file is deleted. */
  campaign?: string;
}

export type ReadDecision =
  | { kind: 'first-read' }
  | { kind: 'replay'; prior: OosRead }
  | { kind: 'refused'; prior: OosRead; reason: string };

const overlaps = (a: Pick<OosRead, 'testFromIso' | 'testToIso'>, b: Pick<OosRead, 'testFromIso' | 'testToIso'>): boolean =>
  Date.parse(a.testFromIso) < Date.parse(b.testToIso) && Date.parse(b.testFromIso) < Date.parse(a.testToIso);

export function decideRead(ledger: readonly OosRead[], next: Omit<OosRead, 'readAtIso' | 'runId'>): ReadDecision {
  let replay: OosRead | null = null;
  for (const prior of ledger) {
    if (prior.specId !== next.specId || prior.symbol !== next.symbol || prior.timeframe !== next.timeframe) continue;
    if (!overlaps(prior, next)) continue;
    if (prior.specHash !== next.specHash) {
      return {
        kind: 'refused',
        prior,
        reason: `${next.specId} ${next.symbol} ${next.timeframe}: test window ${prior.testFromIso}..${prior.testToIso} was already read under spec hash ${prior.specHash.slice(0, 12)}; a changed spec needs a new, unread test window`,
      };
    }
    if (prior.testFromIso === next.testFromIso && prior.testToIso === next.testToIso) replay = prior;
  }
  return replay ? { kind: 'replay', prior: replay } : { kind: 'first-read' };
}

export function readLedger(file: string): OosRead[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as OosRead;
      } catch {
        throw new Error(`${file}:${i + 1}: unreadable ledger line; the ledger is append-only and must not be edited by hand`);
      }
    });
}

export function appendRead(file: string, read: OosRead): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(read)}\n`);
}
