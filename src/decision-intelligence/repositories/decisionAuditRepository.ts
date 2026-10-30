/**
 * DecisionAuditRepository: append-only JSONL persistence for every Tev1
 * evaluation, following the DecisionJournal pattern (best-effort writes that
 * never throw into the trading loop; a null path means in-memory, for tests and
 * replay).
 *
 * Why a separate journal instead of the decision journal: every gated signal
 * already produces exactly one DecisionRecord; the Tev1 layer adds zero or one
 * EVALUATION per candidate, and the audit row must carry the full request
 * (model tag, question versions, snapshot) and the raw response so any decision
 * can be replayed and — once outcomes are attached — benchmarked against
 * reality (false approvals, missed opportunities, per-weakness refusal rates).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DecisionAuditRecord } from '../types.js';

export class DecisionAuditRepository {
  private readonly filePath: string | null;
  /** In-memory rows when path is null; also used to read back what was written in tests. */
  private rows: DecisionAuditRecord[] = [];

  constructor(filePath: string | null) {
    this.filePath = filePath;
  }

  /** Appends one record. A write failure is logged to stderr, never thrown. */
  append(record: DecisionAuditRecord): void {
    this.rows.push(record);
    if (this.filePath === null) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (err) {
      console.error(`[tev1-audit] failed to persist audit record ${record.auditId}: ${(err as Error).message}`);
    }
  }

  /** Loads every record from the file (or from memory when path is null). Malformed lines are skipped, not fatal. */
  load(): DecisionAuditRecord[] {
    if (this.filePath === null) return [...this.rows];
    if (!existsSync(this.filePath)) return [];
    try {
      return readFileSync(this.filePath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as DecisionAuditRecord;
          } catch {
            return null;
          }
        })
        .filter((row): row is DecisionAuditRecord => row !== null);
    } catch (err) {
      console.error(`[tev1-audit] failed to read ${this.filePath}: ${(err as Error).message}`);
      return [];
    }
  }
}
