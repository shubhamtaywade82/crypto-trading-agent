import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FLEET_MODEL_ID,
  DEFAULT_FLEET_MODEL_TAG,
  FLEET_MODEL_REGISTRY,
  isValidOllamaTag,
  lookupModelByTag,
  parseModelRoute,
  resolveFleetModelAssignment,
  resolveModelTag,
  shortModelTag,
} from '../src/minicpm/FleetModels.js';

const SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;

test('registry: control model is MiniCPM5-2B and the default resolves to its exact tag', () => {
  const control = FLEET_MODEL_REGISTRY.find((m) => m.id === DEFAULT_FLEET_MODEL_ID);
  assert.ok(control, 'control model must exist in the registry');
  assert.equal(control.role, 'control');
  assert.equal(resolveModelTag(DEFAULT_FLEET_MODEL_ID), DEFAULT_FLEET_MODEL_TAG);
});

test('registry: ids are unique and every ollamaTag is a valid tag shape', () => {
  const ids = new Set(FLEET_MODEL_REGISTRY.map((m) => m.id));
  assert.equal(ids.size, FLEET_MODEL_REGISTRY.length, 'registry ids must be unique');
  for (const m of FLEET_MODEL_REGISTRY) {
    assert.ok(isValidOllamaTag(m.ollamaTag), `${m.ollamaTag} must be a valid tag shape`);
  }
});

test('resolveModelTag: registry ids resolve to their ollama tags (case-insensitive)', () => {
  assert.equal(resolveModelTag('qwen3.5-2b'), 'qwen3.5:2b');
  assert.equal(resolveModelTag('LFM2.5-2.6B'.toLowerCase()), 'LiquidAI/lfm2.5-2.6b');
  assert.equal(resolveModelTag('granite4.2-3b'), 'granite4.2:3b');
  assert.equal(resolveModelTag('nemotron3-nano-4b'), 'nemotron-3-nano:4b');
});

test('resolveModelTag: raw Ollama tags pass through untouched', () => {
  assert.equal(resolveModelTag('qwen3:4b'), 'qwen3:4b');
  assert.equal(resolveModelTag('some-owner/custom-model:7b'), 'some-owner/custom-model:7b');
});

test('resolveModelTag: a typo that matches neither registry nor tag shape fails loudly', () => {
  assert.throws(() => resolveModelTag('qwen35 2b'), /unknown fleet model/);
  assert.throws(() => resolveModelTag(''), /unknown fleet model/);
});

test('parseModelRoute: SYMBOL=MODEL pairs with case/USDT-suffix tolerance', () => {
  const route = parseModelRoute('ETH=qwen3.5:2b,solusdt=lfm2.5-2.6b, XRP = granite4.2:3b');
  assert.deepEqual(route.bySymbol, {
    ETH: 'qwen3.5:2b',
    SOL: 'LiquidAI/lfm2.5-2.6b',
    XRP: 'granite4.2:3b',
  });
});

test('parseModelRoute: malformed pairs throw with a useful message', () => {
  assert.throws(() => parseModelRoute('ETH'), /expected SYMBOL=MODEL/);
  assert.throws(() => parseModelRoute('=qwen3.5:2b'), /empty symbol|expected SYMBOL=MODEL/);
  assert.throws(() => parseModelRoute('ETH=qwen35 2b'), /unknown fleet model/);
});

test('parseModelRoute: empty route yields no overrides', () => {
  assert.deepEqual(parseModelRoute('  ').bySymbol, {});
});

test('resolveFleetModelAssignment: default fills every symbol with the control tag', () => {
  const a = resolveFleetModelAssignment({ symbols: SYMBOLS, defaultSpec: DEFAULT_FLEET_MODEL_ID });
  for (const s of SYMBOLS) assert.equal(a.bySymbol[s], DEFAULT_FLEET_MODEL_TAG);
  assert.deepEqual(a.distinctTags, [DEFAULT_FLEET_MODEL_TAG]);
});

test('resolveFleetModelAssignment: route overrides only the named symbols', () => {
  const a = resolveFleetModelAssignment({
    symbols: SYMBOLS,
    defaultSpec: 'qwen3.5-2b',
    route: parseModelRoute('SOL=lfm2.5-2.6b'),
  });
  assert.equal(a.bySymbol['ETHUSDT'], 'qwen3.5:2b');
  assert.equal(a.bySymbol['SOLUSDT'], 'LiquidAI/lfm2.5-2.6b');
  assert.equal(a.bySymbol['XRPUSDT'], 'qwen3.5:2b');
  assert.equal(a.distinctTags.length, 2);
});

test('resolveFleetModelAssignment: a route naming an untraded symbol fails at boot, not silently', () => {
  assert.throws(
    () => resolveFleetModelAssignment({ symbols: SYMBOLS, defaultSpec: DEFAULT_FLEET_MODEL_ID, route: parseModelRoute('DOGE=qwen3.5:2b') }),
    /does not trade it/,
  );
});

test('lookupModelByTag: known tags carry metadata, passthrough tags do not', () => {
  assert.equal(lookupModelByTag('qwen3.5:2b')?.label, 'Qwen 3.5 2B');
  assert.equal(lookupModelByTag('totally/unknown:1b'), undefined);
});

test('shortModelTag: owner namespace is stripped for display', () => {
  assert.equal(shortModelTag('LiquidAI/lfm2.5-2.6b'), 'lfm2.5-2.6b');
  assert.equal(shortModelTag('qwen3.5:2b'), 'qwen3.5:2b');
  assert.equal(shortModelTag('openbmb/minicpm5-2b:latest'), 'minicpm5-2b:latest');
});

test('every shortlisted role maps to a suggested workload and no model exceeds 4GB download', () => {
  const roles = new Set(FLEET_MODEL_REGISTRY.map((m) => m.role));
  for (const expected of ['control', 'trading-analysis', 'tool-execution', 'reasoning', 'routing', 'structured'] as const) {
    assert.ok(roles.has(expected), `registry should cover the ${expected} workload`);
  }
  for (const m of FLEET_MODEL_REGISTRY) {
    assert.ok(m.sizeGb > 0 && m.sizeGb < 4, `${m.id} download size must stay under 4GB`);
  }
});
