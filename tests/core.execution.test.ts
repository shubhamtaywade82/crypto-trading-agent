import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryOwnershipJournal } from '../src/core/adapters/persistence/OwnershipJournals.js';
import { PlacePaperOrderHandler } from '../src/core/application/execution/PlacePaperOrderHandler.js';
import { OwnershipLedger } from '../src/core/application/ownership/OwnershipLedger.js';
import { RiskPipeline } from '../src/core/application/risk/RiskPipeline.js';
import { buildPlaceOrderCommand, type PlaceOrderCommand } from '../src/core/domain/execution.js';
import type { OwnershipJournalPort } from '../src/core/ports/OwnershipJournalPort.js';
import { VenueRejectedError, VenueUnavailableError, type VenueOrderAck } from '../src/core/ports/PaperExecutionPort.js';
import { candlesFromCloses, FakeExecution, LIMITS, portfolioOf, signalOf, snapshotOf, T0, TEST_ACCOUNT, TEST_SCOPE } from './support/coreFixtures.js';

const clock = { now: () => T0 };

function command(decisionId = 'dec_1'): PlaceOrderCommand {
  const signal = signalOf();
  const proposal = { decisionId, signal, supportingStrategies: [], symbol: 'BTCUSDT', direction: 'LONG' as const, entry: 100, stopLoss: 98, takeProfit: 106, quantity: 0.5, leverage: 2, notional: 50, riskAmount: 1.06 };
  const verdict = new RiskPipeline([{ id: 'pass', evaluate: () => null }], clock).evaluate(proposal, {
    market: snapshotOf('BTCUSDT', candlesFromCloses([100, 100])), portfolio: portfolioOf(), limits: LIMITS, executedDecisionIds: new Set(),
    haltReason: null, foreignPositionSymbols: [],
  });
  return buildPlaceOrderCommand(verdict.approved!, T0, TEST_SCOPE);
}

/** A venue, a journal and a handler bound to the test account. */
function rig(venue = new FakeExecution()) {
  const journal = new InMemoryOwnershipJournal();
  const ledger = new OwnershipLedger(journal, TEST_ACCOUNT);
  const handler = new PlacePaperOrderHandler(venue, clock, ledger, TEST_SCOPE);
  return { venue, journal, ledger, handler };
}

const queued: VenueOrderAck = { venueOrderId: 'intent-7', status: 'QUEUED', filledQuantity: 0, averagePrice: null, protectionCarried: true };
const path = (result: { transitions: readonly { to: string }[] }) => result.transitions.map((t) => t.to).join('>');

test('a filled entry is journaled, owned by its episode and protected on that slot', async () => {
  const { venue, ledger, handler } = rig();
  const cmd = command();
  const result = await handler.handle(cmd);
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'ATTACHED');
  assert.equal(result.filledQuantity, 0.5);
  assert.equal(path(result), 'VALIDATED>SUBMITTED>FILLED');
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'readSlot', 'protect']);
  const episode = ledger.get(cmd.commandId);
  assert.deepEqual([episode?.state, episode?.slotId], ['OWNED', 1]);
  assert.deepEqual(venue.protections[0].owned, { accountId: TEST_ACCOUNT, symbol: 'BTCUSDT', slotId: 1, episodeId: cmd.commandId });
});

test('the intent is durable before the venue is asked for anything', async () => {
  const { venue, journal, handler } = rig();
  let journalAtSubmit: string[] = [];
  venue.submitScript = [() => {
    journalAtSubmit = journal.load().map((event) => event.type);
    return FakeExecution.filled(0.5);
  }];
  await handler.handle(command());
  assert.deepEqual(journalAtSubmit, ['intent']);
});

test('an entry is not sent when its intent cannot be journaled', async () => {
  const venue = new FakeExecution();
  const failing: OwnershipJournalPort = { append: () => { throw new Error('disk full'); }, load: () => [] };
  const handler = new PlacePaperOrderHandler(venue, clock, new OwnershipLedger(failing, TEST_ACCOUNT), TEST_SCOPE);
  const result = await handler.handle(command());
  assert.equal(result.state, 'REJECTED');
  assert.match(result.detail, /could not be journaled, nothing was sent: disk full/);
  assert.deepEqual(venue.calls, ['readSlot']);
});

test('an entry is refused when the slot is already open, and nothing is sent', async () => {
  const { venue, handler } = rig();
  venue.openSlot('BTCUSDT', 0.3, 9);
  const result = await handler.handle(command());
  assert.equal(result.state, 'REJECTED');
  assert.match(result.detail, /already open/);
  assert.deepEqual(venue.calls, ['readSlot']);
  assert.equal(venue.submitted.length, 0);
});

test('a handler refuses a command for another account, and refuses a port bound to another account', async () => {
  const { handler } = rig();
  const result = await handler.handle({ ...command(), accountId: 'someone-else' });
  assert.equal(result.state, 'REJECTED');
  assert.match(result.detail, /targets account someone-else; this handler is bound to acct-test/);
  const other = new FakeExecution('acct-other');
  assert.throws(() => new PlacePaperOrderHandler(other, clock, new OwnershipLedger(new InMemoryOwnershipJournal(), TEST_ACCOUNT), TEST_SCOPE), /bound to acct-other/);
});

test('the same command is submitted once, however often and however concurrently it is handled', async () => {
  const venue = new FakeExecution();
  let release!: () => void;
  venue.gate = new Promise<void>((resolve) => { release = resolve; });
  const { handler } = rig(venue);
  const cmd = command();
  const inFlight = [handler.handle(cmd), handler.handle(cmd), handler.handle({ ...cmd })];
  release();
  const results = await Promise.all(inFlight);
  const later = await handler.handle(cmd);
  assert.equal(venue.submitted.length, 1);
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'readSlot', 'protect']);
  for (const result of [...results, later]) assert.equal(result, results[0]);
});

test('a venue rejection ends REJECTED, is not retried, and abandons its episode', async () => {
  const { venue, ledger, handler } = rig();
  venue.submitScript = [new VenueRejectedError('insufficient margin')];
  const cmd = command();
  const result = await handler.handle(cmd);
  assert.equal(result.state, 'REJECTED');
  assert.match(result.detail, /venue rejected: insufficient margin/);
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder']);
  assert.equal(ledger.get(cmd.commandId)?.state, 'ABANDONED');
});

test('a lost answer is reconciled by idempotency key before anything is resent', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout')];
  // The order landed even though the answer was lost: the venue shows it filled and the slot open
  venue.findScript = [() => { venue.openSlot('BTCUSDT', 0.5); return FakeExecution.filled(0.5); }];
  const { handler } = rig(venue);
  const result = await handler.handle(command());
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'ATTACHED');
  // The order had landed: one submission, found by key, then protected. No second order.
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'findOrder', 'readSlot', 'protect']);
});

test('when the venue has no such order it is resent once, under the same key', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout'), FakeExecution.filled(0.5)];
  venue.findScript = [null];
  const { handler } = rig(venue);
  const result = await handler.handle(command());
  assert.equal(result.state, 'FILLED');
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'findOrder', 'submitOrder', 'readSlot', 'protect']);
  assert.equal(venue.submitted[0].idempotencyKey, venue.submitted[1].idempotencyKey);
});

test('an outcome that stays unknown ends UNKNOWN after exactly two submissions, with its intent left open', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout')];
  const { ledger, handler } = rig(venue);
  const result = await handler.handle(command());
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /outcome unknown/);
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'findOrder', 'submitOrder']);
  assert.equal(ledger.openIntents().length, 1);

  const blind = new FakeExecution();
  blind.submitScript = [new VenueUnavailableError('timeout')];
  blind.findScript = [new VenueUnavailableError('still down')];
  const unknown = await rig(blind).handler.handle(command('dec_2'));
  assert.equal(unknown.state, 'UNKNOWN');
  // Reconciliation itself failed, so nothing may be resent
  assert.deepEqual(blind.calls, ['readSlot', 'submitOrder', 'findOrder']);
});

test('a fill that cannot be protected is flattened, and its episode is closed', async () => {
  const { venue, ledger, handler } = rig();
  venue.protectScript = [new VenueUnavailableError('protections endpoint down')];
  const cmd = command();
  const result = await handler.handle(cmd);
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'FAILED');
  assert.match(result.detail, /position flattened/);
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'readSlot', 'protect', 'flatten', 'readSlot']);
  assert.equal(venue.flattened[0].episodeId, cmd.commandId);
  assert.equal(ledger.get(cmd.commandId)?.state, 'CLOSED');
});

test('a fill that can be neither protected nor flattened is an unprotected position, and it stays owned', async () => {
  const { venue, ledger, handler } = rig();
  venue.protectScript = [new VenueUnavailableError('down')];
  venue.flattenScript = [new VenueUnavailableError('down')];
  const cmd = command();
  const result = await handler.handle(cmd);
  assert.equal(result.protection, 'FAILED');
  assert.match(result.detail, /^UNPROTECTED POSITION/);
  // Still ours on the books: the breaker halts, and the position is reported, not treated as foreign
  assert.equal(ledger.get(cmd.commandId)?.state, 'OWNED');
});

test('a fill the venue cannot attribute is abandoned and nothing is attached to it', async () => {
  const { venue, ledger, handler } = rig();
  venue.openSlotOnFill = false;
  const cmd = command();
  const result = await handler.handle(cmd);
  assert.equal(result.state, 'FILLED');
  assert.equal(result.protection, 'FAILED');
  assert.match(result.detail, /^UNOWNED POSITION: no open position in the slot after the fill/);
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder', 'readSlot']);
  assert.equal(ledger.get(cmd.commandId)?.state, 'ABANDONED');
});

test('a partial fill is owned and protected like a fill', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [{ venueOrderId: 'v-2', status: 'PARTIALLY_FILLED', filledQuantity: 0.2, averagePrice: null, protectionCarried: false }];
  const { handler } = rig(venue);
  const result = await handler.handle(command());
  assert.equal(result.state, 'PARTIALLY_FILLED');
  assert.equal(result.filledQuantity, 0.2);
  assert.equal(result.protection, 'ATTACHED');
});

test('a queued replay order stays an open intent until the venue reports its fill', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [queued];
  const { ledger, handler } = rig(venue);
  const cmd = command();
  const result = await handler.handle(cmd);
  assert.equal(result.state, 'ACKNOWLEDGED');
  assert.equal(result.protection, 'PENDING_FILL');
  assert.equal(result.venueOrderId, 'intent-7');
  assert.deepEqual(venue.calls, ['readSlot', 'submitOrder']);
  assert.equal(ledger.get(cmd.commandId)?.state, 'INTENT');
});

test('an invalid command is rejected before it reaches the venue', async () => {
  const { venue, handler } = rig();
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
