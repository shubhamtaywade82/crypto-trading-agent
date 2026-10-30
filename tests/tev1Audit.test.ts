import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DecisionAuditRepository } from '../src/decision-intelligence/repositories/decisionAuditRepository.js';
import type { DecisionAuditRecord } from '../src/decision-intelligence/types.js';

function record(auditId: string, over: Partial<DecisionAuditRecord> = {}): DecisionAuditRecord {
  return {
    auditId,
    timestamp: 1_790_000_000_000,
    decisionId: `decision-${auditId}`,
    symbol: 'SOLUSDT',
    model: 'tev1:4b',
    questionSetVersion: '1.0.0',
    policyVersion: '1.0.0',
    mode: 'shadow',
    latencyMs: 640,
    snapshot: { symbol: 'SOLUSDT' } as DecisionAuditRecord['snapshot'],
    request: { model: 'tev1:4b', state: {}, questions: {} },
    response: { answers: {} },
    error: null,
    evaluation: { ok: true, tradeDecision: null, primaryWeakness: null, mtfAlignment: null, invalidReasons: [] },
    verdict: { gate: 'PASS', action: 'PROCEED', enforced: false, mode: 'shadow', choice: 'APPROVE', confidence: 0.8, reason: 'tev1: APPROVE' },
    ...over,
  };
}

test('a null path keeps records in memory only', () => {
  const repo = new DecisionAuditRepository(null);
  repo.append(record('a1'));
  repo.append(record('a2'));
  assert.deepEqual(repo.load().map((r) => r.auditId), ['a1', 'a2']);
});

test('appends to a JSONL file, creating directories as needed, and loads the rows back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tev1-audit-'));
  const file = path.join(dir, 'nested', 'tev1-decisions.jsonl');
  const repo = new DecisionAuditRepository(file);
  repo.append(record('a1', { verdict: { gate: 'BLOCK', action: 'REFUSE', enforced: true, mode: 'on', choice: 'NO_TRADE', confidence: 0.9, reason: 'tev1: NO_TRADE' } }));
  repo.append(record('a2'));

  const onDisk = readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(onDisk.length, 2);
  assert.equal(JSON.parse(onDisk[0]).auditId, 'a1');

  const loaded = new DecisionAuditRepository(file).load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].verdict.action, 'REFUSE');
  assert.equal(loaded[1].model, 'tev1:4b');
});

test('a write failure never throws into the caller', () => {
  // A path whose directory cannot be created (parent is a regular file) forces the write to fail.
  const dir = mkdtempSync(path.join(tmpdir(), 'tev1-audit-blocked-'));
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'regular file');
  const repo = new DecisionAuditRepository(path.join(blocker, 'tev1-decisions.jsonl'));
  assert.doesNotThrow(() => repo.append(record('a1')));
});

test('malformed lines are skipped when loading, not fatal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tev1-audit-corrupt-'));
  const file = path.join(dir, 'tev1-decisions.jsonl');
  const good = record('a1');
  writeFileSync(file, `${JSON.stringify(good)}\nnot json at all\n\n${JSON.stringify(record('a2'))}\n`, 'utf-8');
  const loaded = new DecisionAuditRepository(file).load();
  assert.deepEqual(loaded.map((r) => r.auditId), ['a1', 'a2']);
});

test('a missing file loads as empty', () => {
  const repo = new DecisionAuditRepository(path.join(tmpdir(), `tev1-audit-missing-${Date.now()}`, 'tev1-decisions.jsonl'));
  assert.deepEqual(repo.load(), []);
});

test('every audit row carries the replay essentials: model, versions, request, response and verdict', () => {
  const repo = new DecisionAuditRepository(null);
  repo.append(record('a1'));
  const row = repo.load()[0];
  for (const key of ['model', 'questionSetVersion', 'policyVersion', 'request', 'response', 'evaluation', 'verdict', 'snapshot', 'latencyMs'] as const) {
    assert.ok(key in row, `audit row must carry ${key}`);
  }
});
