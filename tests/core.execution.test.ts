import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlacePaperOrderHandler } from '../src/core/application/execution/PlacePaperOrderHandler.js';
import { RiskPipeline } from '../src/core/application/risk/RiskPipeline.js';
import { buildPlaceOrderCommand, type PlaceOrderCommand } from '../src/core/domain/execution.js';
import { VenueRejectedError, VenueUnavailableError, type VenueOrderAck } from '../src/core/ports/PaperExecutionPort.js';
import { candlesFromCloses, FakeExecution, LIMITS, portfolioOf, signalOf, snapshotOf, T0 } from './support/coreFixtures.js';

const clock = { now: () => T0 };

function command(decisionId = 'dec_1'): PlaceOrderCommand {
  const signal = signalOf();
  const proposal = { decisionId, signal, supportingStrategies: [], symbol: 'BTCUSDT', direction: 'LONG' as const, entry: 100, stopLoss: 98, takeProfit: 106, quantity: 0.5, leverage: 2, notional: 50, riskAmount: 1.06 };
  const verdict = new RiskPipeline([{ id: 'pass', evaluate: () => null }], clock).evaluate(proposal, {
    market: snapshotOf('BTCUSDT', candlesFromCloses([100, 100])), portfolio: portfolioOf(), limits: LIMITS, executedDecisionIds: new Set(), haltReason: null,
  });
  return buildPlaceOrderCommand(verdict.approved!, T0);
}

const queued: VenueOrderAck = { venueOrderId: 'intent-7', status: 'QUEUED', filledQuantity: 0, averagePrice: null, protectionCarried: true };
const path = (result: { transitions: readonly { to: string }[] }) => result.transitions.map((t) => t.to).join('>');

test('a filled entry is protected and ends FILLED', async () => {
  const venue = new FakeExecution();
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'ATTACHED');
  assert.equal(result.filledQuantity, 0.5);
  assert.equal(path(result), 'VALIDATED>SUBMITTED>FILLED');
  assert.deepEqual(venue.calls, ['submitOrder', 'protect']);
});

test('the same command is submitted once, however often and however concurrently it is handled', async () => {
  const venue = new FakeExecution();
  let release!: () => void;
  venue.gate = new Promise<void>((resolve) => { release = resolve; });
  const handler = new PlacePaperOrderHandler(venue, clock);
  const cmd = command();
  const inFlight = [handler.handle(cmd), handler.handle(cmd), handler.handle({ ...cmd })];
  release();
  const results = await Promise.all(inFlight);
  const later = await handler.handle(cmd);
  assert.equal(venue.submitted.length, 1);
  assert.deepEqual(venue.calls, ['submitOrder', 'protect']);
  for (const result of [...results, later]) assert.equal(result, results[0]);
});

test('a venue rejection ends REJECTED and is not retried', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueRejectedError('insufficient margin')];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'REJECTED');
  assert.match(result.detail, /venue rejected: insufficient margin/);
  assert.deepEqual(venue.calls, ['submitOrder']);
});

test('a lost answer is reconciled by idempotency key before anything is resent', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout')];
  venue.findScript = [FakeExecution.filled(0.5)];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'ATTACHED');
  // The order had landed: one submission, found by key, then protected. No second order.
  assert.deepEqual(venue.calls, ['submitOrder', 'findOrder', 'protect']);
});

test('when the venue has no such order it is resent once, under the same key', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout'), FakeExecution.filled(0.5)];
  venue.findScript = [null];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'FILLED');
  assert.deepEqual(venue.calls, ['submitOrder', 'findOrder', 'submitOrder', 'protect']);
  assert.equal(venue.submitted[0].idempotencyKey, venue.submitted[1].idempotencyKey);
});

test('an outcome that stays unknown ends UNKNOWN after exactly two submissions', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout')];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /outcome unknown/);
  assert.deepEqual(venue.calls, ['submitOrder', 'findOrder', 'submitOrder']);

  const blind = new FakeExecution();
  blind.submitScript = [new VenueUnavailableError('timeout')];
  blind.findScript = [new VenueUnavailableError('still down')];
  const unknown = await new PlacePaperOrderHandler(blind, clock).handle(command());
  assert.equal(unknown.state, 'UNKNOWN');
  // Reconciliation itself failed, so nothing may be resent
  assert.deepEqual(blind.calls, ['submitOrder', 'findOrder']);
});

test('a fill that cannot be protected is flattened', async () => {
  const venue = new FakeExecution();
  venue.protectScript = [new VenueUnavailableError('protections endpoint down')];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'FAILED');
  assert.match(result.detail, /position flattened/);
  assert.deepEqual(venue.calls, ['submitOrder', 'protect', 'flatten']);
});

test('a fill that can be neither protected nor flattened is reported as an unprotected position', async () => {
  const venue = new FakeExecution();
  venue.protectScript = [new VenueUnavailableError('down')];
  venue.flattenScript = [new VenueUnavailableError('down')];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.protection, 'FAILED');
  assert.match(result.detail, /^UNPROTECTED POSITION/);
});

test('a partial fill is protected like a fill', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [{ venueOrderId: 'v-2', status: 'PARTIALLY_FILLED', filledQuantity: 0.2, averagePrice: null, protectionCarried: false }];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'PARTIALLY_FILLED');
  assert.equal(result.filledQuantity, 0.2);
  assert.equal(result.protection, 'ATTACHED');
});

test('a queued replay order carries its stop on the order and needs no protection call', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [queued];
  const result = await new PlacePaperOrderHandler(venue, clock).handle(command());
  assert.equal(result.state, 'ACKNOWLEDGED');
  assert.equal(result.protection, 'PENDING_FILL');
  assert.equal(result.venueOrderId, 'intent-7');
  assert.deepEqual(venue.calls, ['submitOrder']);
});

test('an invalid command is rejected before it reaches the venue', async () => {
  const venue = new FakeExecution();
  const handler = new PlacePaperOrderHandler(venue, clock);
  const base = command();
  const cases: Array<[Partial<PlaceOrderCommand>, RegExp]> = [
    [{ commandId: 'a', quantity: 0 }, /quantity/], [{ commandId: 'b', quantity: Number.NaN }, /quantity/],
    [{ commandId: 'c', stopLoss: 101 }, /stop is not beyond/], [{ commandId: 'd', stopLoss: Number.NaN }, /positive finite/],
    [{ commandId: 'e', idempotencyKey: '' }, /idempotency key/], [{ commandId: 'f', side: 'SELL' }, /stop is not beyond/],
  ];
  for (const [change, expected] of cases) {
    const result = await handler.handle({ ...base, ...change });
    assert.equal(result.state, 'REJECTED');
    assert.match(result.detail, expected);
  }
  assert.deepEqual(venue.calls, []);
});
