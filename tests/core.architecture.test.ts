import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PolicyViolationError } from '@nemesis-oss/binance-sdk';
import { createReadOnlyBinanceClient } from '../src/core/adapters/binance/BinanceMarketDataAdapter.js';

/**
 * P0: the paper core has no live execution path. These tests prove it structurally (the import graph cannot reach a
 * live order module) and at the transport (the only Binance client the core builds refuses every order).
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const CORE = path.join(ROOT, 'src/core');
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'"`;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Import { specifier: string; typeOnly: boolean }

function importsOf(file: string): Import[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT)].map((m) => ({ specifier: m[2] ?? m[3] ?? m[4], typeOnly: Boolean(m[1]) }));
}

function resolveLocal(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/, ''));
  const hit = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(existsSync);
  assert.ok(hit, `${rel(from)} imports ${specifier}, which does not resolve to a file`);
  return hit;
}

/** Every file reachable from the core through runtime (non type-only) imports, and every package it loads. */
function runtimeClosure(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>(), packages = new Map<string, string>();
  const queue = walk(CORE);
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const { specifier, typeOnly } of importsOf(file)) {
      if (typeOnly) continue;
      if (specifier.startsWith('.')) queue.push(resolveLocal(file, specifier));
      else if (!packages.has(specifier)) packages.set(specifier, rel(file));
    }
  }
  return { files, packages };
}

const closure = runtimeClosure();
const coreFiles = walk(CORE);
const layerOf = (file: string): string => rel(file).split('/')[2];

test('the core only reaches three legacy modules, none of which can place a live order', () => {
  const outside = [...closure.files].map(rel).filter((file) => !file.startsWith('src/core/')).sort();
  assert.deepEqual(outside, ['src/binance/indicators.ts', 'src/binance/paperExchangeClient.ts', 'src/ollama/jsonMode.ts']);
});

test('no live-execution module or live-capable package is reachable from the core', () => {
  const forbiddenFiles = [
    'src/config.ts', 'src/binance/client.ts', 'src/binance/liveEntry.ts', 'src/binance/liveBook.ts', 'src/binance/liveProtection.ts',
    'src/binance/liveJournal.ts', 'src/binance/userDataStream.ts', 'src/binance/remoteBroker.ts', 'src/agents/ExecutorAgent.ts', 'src/runtime/Orchestrator.ts',
  ];
  for (const file of forbiddenFiles) {
    assert.ok(existsSync(path.join(ROOT, file)), `${file} moved; update this guard`);
    assert.ok(!closure.files.has(path.join(ROOT, file)), `${file} is reachable from src/core`);
  }
  assert.ok(![...closure.files].some((file) => rel(file).startsWith('src/coindcx/')), 'a CoinDCX module is reachable from src/core');
  // `binance` is the signed USDMClient the legacy live path trades through; the CoinDCX SDK is the other live venue
  for (const pkg of ['binance', '@nemesis-oss/coindcx-sdk']) assert.ok(!closure.packages.has(pkg), `package ${pkg} is imported by ${closure.packages.get(pkg)}`);
  assert.deepEqual(
    [...closure.packages.keys()].filter((pkg) => !pkg.startsWith('node:')).sort(),
    ['@nemesis-oss/binance-sdk', '@nemesis-oss/ollama-sdk', 'dotenv/config', 'zod'],
  );
});

test('the core source names no order-placing SDK surface and no trading credential', () => {
  const banned = /futures\.(execution|trading|account|userStream)|\.placeOrder\(|submitNewOrder|createOrder\(|BINANCE_API_KEY|BINANCE_API_SECRET|COINDCX_API|apiSecret/;
  for (const file of coreFiles) {
    const code = readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    assert.ok(!banned.test(code), `${rel(file)} references a trading surface or credential: ${banned.exec(code)?.[0]}`);
  }
});

test('the Binance client the core builds carries no credentials and refuses every order before it is sent', async () => {
  const client = createReadOnlyBinanceClient(['BTCUSDT']) as any;
  const order = { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001 };
  await assert.rejects(() => client.futures.execution.placeOrder(order), (error: unknown) => error instanceof PolicyViolationError && /readOnly/.test(String((error as Error).message)));
  await assert.rejects(() => client.futures.trading.createOrder(order), (error: unknown) => error instanceof PolicyViolationError);
  await assert.rejects(() => client.futures.trading.cancelAllOpenOrders('BTCUSDT'), (error: unknown) => error instanceof PolicyViolationError);
});

test('SDK packages are imported by adapters only', () => {
  for (const file of coreFiles) {
    for (const { specifier } of importsOf(file)) {
      if (!specifier.startsWith('@nemesis-oss/')) continue;
      assert.equal(layerOf(file), 'adapters', `${rel(file)} imports ${specifier}`);
      const adapter = rel(file).split('/')[3];
      assert.equal(adapter, specifier.includes('binance') ? 'binance' : 'ollama', `${rel(file)} imports ${specifier}`);
    }
  }
});

test('dependencies point inward: domain <- ports/events <- application <- adapters <- composition', () => {
  const allowed: Record<string, readonly string[]> = {
    domain: ['domain'],
    events: ['domain', 'events', 'ports'],
    ports: ['domain', 'ports', 'events'],
    risk: ['domain'],
    strategies: ['domain', 'strategies'],
    application: ['domain', 'ports', 'events', 'application', 'research'],
    research: ['domain', 'ports', 'events', 'application', 'research'],
    adapters: ['domain', 'ports', 'events', 'adapters'],
    composition: ['domain', 'ports', 'events', 'application', 'adapters', 'strategies', 'risk', 'research', 'composition'],
    'main.ts': ['domain', 'composition'],
  };
  for (const file of coreFiles) {
    const layer = layerOf(file);
    assert.ok(allowed[layer], `${rel(file)} is in an unknown layer "${layer}"`);
    for (const { specifier, typeOnly } of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = rel(resolveLocal(file, specifier));
      if (!target.startsWith('src/core/')) {
        assert.ok(layer === 'adapters' || target === 'src/binance/indicators.ts', `${rel(file)} reaches outside the core: ${target}`);
        continue;
      }
      const targetLayer = target.split('/')[2];
      // application/engine/TradingApplication names the research types in its facade signature; types only
      if (layer === 'application' && targetLayer === 'research') assert.ok(typeOnly, `${rel(file)} has a runtime import of ${target}`);
      assert.ok(allowed[layer].includes(targetLayer), `${rel(file)} (${layer}) must not import ${target} (${targetLayer})`);
    }
  }
});

test('strategies import nothing but the domain, their own helpers and zod', () => {
  for (const file of coreFiles.filter((f) => layerOf(f) === 'strategies')) {
    for (const { specifier } of importsOf(file)) {
      assert.ok(specifier === 'zod' || specifier.startsWith('.'), `${rel(file)} imports package ${specifier}`);
    }
  }
});

test('only the PaperExchange adapters implement the paper execution port', () => {
  const implementers = coreFiles.filter((file) => /class\s+\w+[^{]*implements[^{]*\bPaperExecutionPort\b/.test(readFileSync(file, 'utf8'))).map(rel).sort();
  assert.deepEqual(implementers, [
    'src/core/adapters/paper-exchange/PaperExchangeExecutionAdapter.ts',
    'src/core/adapters/paper-exchange/PaperExchangeReplayAdapter.ts',
  ]);
  const venues = coreFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/venue\s*[:=]\s*'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(venues)], ['paper_exchange']);
});

test('the advisor adapter cannot reach execution, sizing or risk limits', () => {
  const advisorFiles = coreFiles.filter((file) => rel(file).startsWith('src/core/adapters/ollama/') || rel(file).endsWith('ports/DecisionAdvisorPort.ts'));
  assert.ok(advisorFiles.length >= 2);
  for (const file of advisorFiles) {
    for (const { specifier } of importsOf(file)) {
      assert.ok(!/PaperExecutionPort|execution|risk|PortfolioPort|paper-exchange/i.test(specifier), `${rel(file)} imports ${specifier}`);
    }
  }
});
