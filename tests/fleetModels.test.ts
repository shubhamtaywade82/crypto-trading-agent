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
} from '../src/fleet/FleetModels.js';

const SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;

test('registry: control model is beam and the default resolves to its exact tag', () => {
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
  assert.equal(resolveModelTag('beam'), 'beam');
  assert.equal(resolveModelTag('GPT-OSS-20B'), 'gpt-oss:20b');
  assert.equal(resolveModelTag('gemma4-31b'), 'gemma4:31b');
  assert.equal(resolveModelTag('nemotron-3-nano-30b'), 'nemotron-3-nano:30b');
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
  const route = parseModelRoute('ETH=gpt-oss:20b,solusdt=gemma4-31b, XRP = nemotron-3-super');
  assert.deepEqual(route.bySymbol, {
    ETH: 'gpt-oss:20b',
    SOL: 'gemma4:31b',
    XRP: 'nemotron-3-super',
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
    defaultSpec: 'gpt-oss-20b',
    route: parseModelRoute('SOL=gemma4-31b'),
  });
  assert.equal(a.bySymbol['ETHUSDT'], 'gpt-oss:20b');
  assert.equal(a.bySymbol['SOLUSDT'], 'gemma4:31b');
  assert.equal(a.bySymbol['XRPUSDT'], 'gpt-oss:20b');
  assert.equal(a.distinctTags.length, 2);
});

test('resolveFleetModelAssignment: a route naming an untraded symbol fails at boot, not silently', () => {
  assert.throws(
    () => resolveFleetModelAssignment({ symbols: SYMBOLS, defaultSpec: DEFAULT_FLEET_MODEL_ID, route: parseModelRoute('DOGE=qwen3.5:2b') }),
    /does not trade it/,
  );
});

test('lookupModelByTag: known tags carry metadata, passthrough tags do not', () => {
  assert.equal(lookupModelByTag('gpt-oss:20b')?.label, 'GPT-OSS 20B');
  assert.equal(lookupModelByTag('totally/unknown:1b'), undefined);
});

test('shortModelTag: owner namespace is stripped for display', () => {
  assert.equal(shortModelTag('LiquidAI/lfm2.5-2.6b'), 'lfm2.5-2.6b');
  assert.equal(shortModelTag('qwen3.5:2b'), 'qwen3.5:2b');
});

test('registry covers every suggested workload and lists exactly the Ollama Cloud free tier', () => {
  const roles = new Set(FLEET_MODEL_REGISTRY.map((m) => m.role));
  for (const expected of ['control', 'trading-analysis', 'reasoning', 'structured'] as const) {
    assert.ok(roles.has(expected), `registry should cover the ${expected} workload`);
  }
  assert.deepEqual(
    FLEET_MODEL_REGISTRY.map((m) => m.ollamaTag).sort(),
    ['beam', 'gemma4:31b', 'gpt-oss:120b', 'gpt-oss:20b', 'nemotron-3-nano:30b', 'nemotron-3-super', 'nemotron-3-ultra'],
  );
});
