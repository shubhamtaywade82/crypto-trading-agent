import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawdownResponse } from '../src/risk/drawdownResponse.js';

test('below the limit nothing happens', () => {
  const r = drawdownResponse({ equity: 96, peak: 100, maxPct: 5, action: 'flatten' });
  assert.equal(r.breached, false);
  assert.equal(r.halt, false);
  assert.equal(r.closeAll, false);
});

test('past the limit with the default action, the book is halted and flattened', () => {
  const r = drawdownResponse({ equity: 94, peak: 100, maxPct: 5, action: 'flatten' });
  assert.equal(r.breached, true);
  assert.ok(Math.abs(r.drawdownPct - 6) < 1e-9);
  assert.equal(r.halt, true);
  assert.equal(r.closeAll, true);
  assert.match(r.reason, /6\.00% exceeds 5%/);
});

test('with the block action a breach only refuses entries, and leaves exposure alone', () => {
  const r = drawdownResponse({ equity: 94, peak: 100, maxPct: 5, action: 'block' });
  assert.equal(r.breached, true);
  assert.equal(r.halt, false);
  assert.equal(r.closeAll, false);
});

test('a non-positive equity is a breach, and a zero peak is never a division', () => {
  assert.equal(drawdownResponse({ equity: 0, peak: 100, maxPct: 5, action: 'flatten' }).breached, true);
  assert.equal(drawdownResponse({ equity: 50, peak: 0, maxPct: 5, action: 'flatten' }).breached, false);
});
