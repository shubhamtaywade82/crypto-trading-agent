import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveFleetPaperExchange } from '../src/minicpm/fleetPaperExchange.js';

test('the fleet refuses to start without an operator token, including blank values', () => {
  for (const env of [{}, { PAPER_EXCHANGE_API_KEY: '' }, { PAPER_EXCHANGE_API_KEY: '   ' }]) {
    assert.throws(() => resolveFleetPaperExchange(env), /PAPER_EXCHANGE_API_KEY is not set/);
  }
});

test('the fleet trims the token and defaults the broker URL to the local paper_exchange', () => {
  assert.deepEqual(resolveFleetPaperExchange({ PAPER_EXCHANGE_API_KEY: '  tok  ' }), { url: 'http://127.0.0.1:3100', apiKey: 'tok' });
});

test('the fleet uses PAPER_EXCHANGE_URL without a trailing slash', () => {
  assert.deepEqual(
    resolveFleetPaperExchange({ PAPER_EXCHANGE_API_KEY: 'tok', PAPER_EXCHANGE_URL: 'http://broker.internal:3100/' }),
    { url: 'http://broker.internal:3100', apiKey: 'tok' },
  );
});

/** Regression guard: a quoted 64-hex literal is the shape of the operator token that was once hard-coded in the fleet script. */
test('no source or script file hard-codes a 64-hex token literal', () => {
  const literal = /(['"`])[0-9a-f]{64}\1/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && literal.test(readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk(path.resolve('src'));
  walk(path.resolve('scripts'));
  assert.deepEqual(offenders, []);
});
