import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BinancePublicSource } from '../src/core/adapters/binance/BinanceMarketDataAdapter.js';
import { InMemoryOwnershipJournal, JsonlOwnershipJournal } from '../src/core/adapters/persistence/OwnershipJournals.js';
import { PaperExchangeLeaseAdapter } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseAdapter.js';
import { buildPaperTradingApplication } from '../src/core/composition/buildPaperTradingApplication.js';
import { validatePaperOnlyConfig } from '../src/core/composition/validatePaperOnlyConfig.js';
import { OwnershipLedger } from '../src/core/application/ownership/OwnershipLedger.js';
import { closeEmptiedEpisodes, resolveOpenIntents } from '../src/core/application/ownership/resolve.js';
import {
  applyOwnershipEvent, canEpisodeTransition, classifySlot, foreignSlots, ownershipFromEvidence, OwnershipViolation, reduceOwnership,
  type OwnershipEvent,
} from '../src/core/domain/ownership.js';
import type { RiskContext, TradeProposal } from '../src/core/domain/risk.js';
import { ForeignPositionRule, PositionIdentityRule } from '../src/core/risk/rules/index.js';
import { AccountLeaseHeldError } from '../src/core/ports/AccountLeasePort.js';
import { VenueRejectedError, VenueUnavailableError } from '../src/core/ports/PaperExecutionPort.js';
import { FakeExecution, FakeLease, FakePaperExchange, LIMITS, portfolioOf, positionOf, T0, TEST_ACCOUNT } from './support/coreFixtures.js';

const at = T0;
type IntentEvent = Extract<OwnershipEvent, { type: 'intent' }>;
const intent = (episodeId: string, symbol = 'BTCUSDT', slotQuantityBefore = 0): IntentEvent => ({
  type: 'intent', at, episodeId, accountId: TEST_ACCOUNT, symbol, decisionId: `dec-${episodeId}`, idempotencyKey: `pc-${episodeId}`, slotQuantityBefore,
});

// --- Domain: the episode state machine ----------------------------------------------------------------------------

test('episodes move INTENT -> OWNED -> CLOSED, or INTENT -> ABANDONED, and nothing else', () => {
  const states = ['INTENT', 'OWNED', 'CLOSED', 'ABANDONED'] as const;
  const legal = new Set(['INTENT>OWNED', 'INTENT>ABANDONED', 'OWNED>CLOSED']);
  for (const from of states) {
    for (const to of states) {
      assert.equal(canEpisodeTransition(from, to), legal.has(`${from}>${to}`), `${from} -> ${to}`);
    }
  }
});

test('the event log is applied through the table; illegal and unknown events throw and change nothing', () => {
  const episodes = reduceOwnership([intent('a')]);
  assert.equal(episodes.get('a')?.state, 'INTENT');
  applyOwnershipEvent(episodes, { type: 'owned', at, episodeId: 'a', slotId: 3 });
  assert.deepEqual([episodes.get('a')?.state, episodes.get('a')?.slotId], ['OWNED', 3]);
  assert.throws(() => applyOwnershipEvent(episodes, { type: 'abandoned', at, episodeId: 'a', reason: 'late' }), OwnershipViolation);
  assert.throws(() => applyOwnershipEvent(episodes, { type: 'owned', at, episodeId: 'missing', slotId: 1 }), /unknown episode/);
  assert.throws(() => applyOwnershipEvent(episodes, intent('a')), /already exists/);
  assert.throws(() => applyOwnershipEvent(episodes, { type: 'owned', at, episodeId: 'a', slotId: 3 }), /illegal transition OWNED -> OWNED/);
  assert.throws(() => reduceOwnership([intent('b', 'BTCUSDT', -1)]), /slotQuantityBefore/);
  assert.throws(() => reduceOwnership([{ type: 'owned', at, episodeId: 'x', slotId: 1 }]), /unknown episode/);
  assert.equal(episodes.get('a')?.state, 'OWNED', 'a refused event leaves the state as it was');
});

test('a slot belongs to an episode only if the episode is OWNED for that symbol and slot id', () => {
  const episodes = reduceOwnership([intent('a'), { type: 'owned', at, episodeId: 'a', slotId: 1 }]);
  assert.deepEqual(classifySlot({ symbol: 'BTCUSDT', slotId: 1, quantity: 0.5 }, episodes), { kind: 'OWNED', episodeId: 'a' });
  assert.deepEqual(classifySlot({ symbol: 'BTCUSDT', slotId: 2, quantity: 0.5 }, episodes), { kind: 'FOREIGN' });
  assert.deepEqual(classifySlot({ symbol: 'ETHUSDT', slotId: 1, quantity: 0.5 }, episodes), { kind: 'FOREIGN' });
  assert.deepEqual(classifySlot({ symbol: 'BTCUSDT', slotId: 1, quantity: 0 }, episodes), { kind: 'NONE' });
  assert.deepEqual(classifySlot({ symbol: 'BTCUSDT', slotId: null, quantity: 0.5 }, episodes), { kind: 'FOREIGN' });
  // An intent that never got a fill owns nothing
  const pending = reduceOwnership([intent('p')]);
  assert.equal(classifySlot({ symbol: 'BTCUSDT', slotId: 1, quantity: 0.5 }, pending).kind, 'FOREIGN');
  assert.deepEqual(foreignSlots([{ symbol: 'BTCUSDT', slotId: 1, quantity: 0.5 }, { symbol: 'ETHUSDT', slotId: 4, quantity: 1 }], episodes).map((s) => s.symbol), ['ETHUSDT']);
});

test('a fill is ours only when our order filled and the slot was empty before and open after', () => {
  const owned = { slotQuantityBefore: 0, orderFilled: true, slotAfter: { slotId: 5, quantity: 0.5 } };
  assert.deepEqual(ownershipFromEvidence(owned), { kind: 'OWNED', slotId: 5 });
  assert.deepEqual(ownershipFromEvidence({ ...owned, orderFilled: false }), { kind: 'AMBIGUOUS', reason: 'the order has not filled' });
  assert.deepEqual(ownershipFromEvidence({ ...owned, slotQuantityBefore: 0.1 }), { kind: 'AMBIGUOUS', reason: 'the slot was already open before submission' });
  assert.deepEqual(ownershipFromEvidence({ ...owned, slotAfter: { slotId: null, quantity: 0 } }), { kind: 'AMBIGUOUS', reason: 'no open position in the slot after the fill' });
  assert.deepEqual(ownershipFromEvidence({ ...owned, slotAfter: { slotId: 5, quantity: 0 } }), { kind: 'AMBIGUOUS', reason: 'no open position in the slot after the fill' });
});

// --- The ledger and its journals ----------------------------------------------------------------------------------

test('the ledger validates every change before it is journaled, so a bad event never reaches history', () => {
  const journal = new InMemoryOwnershipJournal();
  const ledger = new OwnershipLedger(journal, TEST_ACCOUNT);
  ledger.recordIntent({ episodeId: 'a', decisionId: 'd', symbol: 'BTCUSDT', idempotencyKey: 'k', slotQuantityBefore: 0, at });
  assert.throws(() => ledger.recordOwned('unknown', 1, at), OwnershipViolation);
  assert.throws(() => ledger.recordClosed('a', 'skipped a step', at), OwnershipViolation);
  assert.equal(journal.load().length, 1, 'only the valid intent was journaled');
  assert.equal(ledger.get('a')?.state, 'INTENT');
  assert.throws(() => new OwnershipLedger(new InMemoryOwnershipJournal(), '  '), /needs an account/);
});

test('a journal that holds another account is refused, so two accounts never share history', () => {
  const journal = new InMemoryOwnershipJournal();
  journal.append({ ...intent('a'), accountId: 'someone-else' });
  assert.throws(() => new OwnershipLedger(journal, TEST_ACCOUNT), /holds episodes for account someone-else/);
});

test('the JSONL journal round-trips, drops a torn final line, and refuses a damaged middle line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ownership-journal-'));
  const file = path.join(dir, 'nested', 'ownership.jsonl');
  const journal = new JsonlOwnershipJournal(file);
  assert.deepEqual(journal.load(), []);
  journal.append(intent('a'));
  journal.append({ type: 'owned', at, episodeId: 'a', slotId: 2 });
  assert.deepEqual(journal.load().map((e) => e.type), ['intent', 'owned']);
  // A crash mid-write leaves a partial line; it was never followed by a submission, so it is dropped
  appendFileSync(file, '{"type":"closed","at":');
  assert.deepEqual(journal.load().map((e) => e.type), ['intent', 'owned']);
  // A damaged line in the middle is not history we can interpret: loading refuses
  writeFileSync(file, 'not json\n{"type":"owned","at":1,"episodeId":"a","slotId":1}\n');
  assert.throws(() => new JsonlOwnershipJournal(file).load(), /line 1 is not valid JSON/);
});

// --- Recovery: intents left open by a previous process ------------------------------------------------------------

test('recovery confirms an intent whose order filled into an empty slot, and abandons one the venue has no order for', async () => {
  const venue = new FakeExecution();
  const ledger = new OwnershipLedger(new InMemoryOwnershipJournal(), TEST_ACCOUNT);
  ledger.recordIntent({ episodeId: 'filled', decisionId: 'd1', symbol: 'BTCUSDT', idempotencyKey: 'k1', slotQuantityBefore: 0, at });
  ledger.recordIntent({ episodeId: 'never', decisionId: 'd2', symbol: 'ETHUSDT', idempotencyKey: 'k2', slotQuantityBefore: 0, at });
  venue.findScript = [FakeExecution.filled(0.5), null];
  venue.openSlot('BTCUSDT', 0.5, 4);
  const result = await resolveOpenIntents({ ledger, execution: venue, at });
  assert.deepEqual([result.owned, result.abandoned, result.pending, result.held.length], [['filled'], ['never'], [], 0]);
  assert.deepEqual([ledger.get('filled')?.state, ledger.get('filled')?.slotId], ['OWNED', 4]);
  assert.equal(ledger.get('never')?.state, 'ABANDONED');
});

test('recovery leaves a queued order pending, abandons a refused one, and holds when the venue cannot be read', async () => {
  const venue = new FakeExecution();
  const ledger = new OwnershipLedger(new InMemoryOwnershipJournal(), TEST_ACCOUNT);
  ledger.recordIntent({ episodeId: 'queued', decisionId: 'd1', symbol: 'BTCUSDT', idempotencyKey: 'k1', slotQuantityBefore: 0, at });
  ledger.recordIntent({ episodeId: 'refused', decisionId: 'd2', symbol: 'ETHUSDT', idempotencyKey: 'k2', slotQuantityBefore: 0, at });
  ledger.recordIntent({ episodeId: 'unreadable', decisionId: 'd3', symbol: 'SOLUSDT', idempotencyKey: 'k3', slotQuantityBefore: 0, at });
  // One answer per intent, in the order the intents were journaled
  venue.findScript = [
    { venueOrderId: 'intent-1', status: 'QUEUED', filledQuantity: 0, averagePrice: null, protectionCarried: true },
    new VenueRejectedError('replay intent 2 is rejected: no margin'),
    new VenueUnavailableError('timeout'),
  ];
  const result = await resolveOpenIntents({ ledger, execution: venue, at });
  assert.deepEqual(result.pending, ['queued']);
  assert.deepEqual(result.abandoned, ['refused']);
  assert.equal(result.held[0]?.episodeId, 'unreadable');
  assert.equal(ledger.get('queued')?.state, 'INTENT');
  assert.equal(ledger.get('refused')?.state, 'ABANDONED');
});

test('recovery holds an intent the venue shows open, and an intent whose slot was already open when it was submitted', async () => {
  const venue = new FakeExecution();
  const ledger = new OwnershipLedger(new InMemoryOwnershipJournal(), TEST_ACCOUNT);
  ledger.recordIntent({ episodeId: 'still-open', decisionId: 'd1', symbol: 'BTCUSDT', idempotencyKey: 'k1', slotQuantityBefore: 0, at });
  ledger.recordIntent({ episodeId: 'shared-slot', decisionId: 'd2', symbol: 'BTCUSDT', idempotencyKey: 'k2', slotQuantityBefore: 0.3, at });
  venue.openSlot('BTCUSDT', 0.5, 4);
  venue.findScript = [new VenueUnavailableError('order still open'), FakeExecution.filled(0.5)];
  const result = await resolveOpenIntents({ ledger, execution: venue, at });
  assert.deepEqual(result.held.map((h) => h.episodeId), ['still-open', 'shared-slot']);
  assert.match(result.held[0].reason, /could not be read: order still open/);
  assert.match(result.held[1].reason, /already open before submission/);
  assert.equal(ledger.get('still-open')?.state, 'INTENT');
  assert.equal(ledger.get('shared-slot')?.state, 'INTENT');
});

test('closing emptied episodes records every OWNED episode whose slot the venue no longer shows open', () => {
  const ledger = new OwnershipLedger(new InMemoryOwnershipJournal(), TEST_ACCOUNT);
  for (const [id, symbol, slot] of [['keep', 'BTCUSDT', 1], ['gone', 'ETHUSDT', 2]] as const) {
    ledger.recordIntent({ episodeId: id, decisionId: id, symbol, idempotencyKey: id, slotQuantityBefore: 0, at });
    ledger.recordOwned(id, slot, at);
  }
  const closed = closeEmptiedEpisodes({ ledger, slots: [{ symbol: 'BTCUSDT', slotId: 1, quantity: 0.5 }], at });
  assert.deepEqual(closed, ['gone']);
  assert.equal(ledger.get('keep')?.state, 'OWNED');
  assert.equal(ledger.get('gone')?.state, 'CLOSED');
});

// --- Risk rules that depend on ownership ---------------------------------------------------------------------------

test('a foreign position blocks entries, and two rows for one symbol are an ambiguous position', () => {
  const proposal = { symbol: 'BTCUSDT' } as TradeProposal;
  const context = (over: Partial<RiskContext>): RiskContext => ({
    market: {} as RiskContext['market'], portfolio: portfolioOf(), limits: LIMITS, executedDecisionIds: new Set(), haltReason: null,
    foreignPositionSymbols: [], ...over,
  });
  assert.equal(ForeignPositionRule.evaluate(proposal, context({})), null);
  const blocked = ForeignPositionRule.evaluate(proposal, context({ foreignPositionSymbols: ['ETHUSDT'] }));
  assert.equal(blocked?.code, 'FOREIGN_POSITION');
  assert.equal(blocked?.severity, 'block');
  const twoRows = portfolioOf({ positions: [positionOf('BTCUSDT'), positionOf('BTCUSDT', { slotId: 2 })] });
  assert.equal(PositionIdentityRule.evaluate(proposal, context({ portfolio: twoRows }))?.code, 'AMBIGUOUS_POSITION');
  assert.equal(PositionIdentityRule.evaluate(proposal, context({ portfolio: portfolioOf({ positions: [positionOf('BTCUSDT')] }) })), null);
});

// --- Composition: start, stop and the lease ----------------------------------------------------------------------

const binanceSource: BinancePublicSource = {
  klines: async () => [],
  premiumIndex: async () => ({ markPrice: 100, lastFundingRate: 0.0001, nextFundingTime: T0 + 8 * 3_600_000, time: T0 }),
  openInterest: async () => ({ openInterest: 1 }),
};

/**
 * A paper core whose ownership journal already holds `journal`. The journal is read when the application is built, as it is
 * when a real process starts, so the events must be written first.
 */
function appWith(overrides: { lease?: FakeLease; journal?: OwnershipEvent[] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'paper-core-own-'));
  const server = new FakePaperExchange();
  const lease = overrides.lease ?? new FakeLease();
  const config = validatePaperOnlyConfig({
    PAPER_EXCHANGE_URL: 'http://paper.test', PAPER_EXCHANGE_ACCOUNT_ID: 'acct', SYMBOLS: 'BTCUSDT',
    PAPER_CORE_STRATEGIES: 'range-breakout', PAPER_CORE_STRATEGY_PARAMS: JSON.stringify({ 'range-breakout': { timeframe: '15m', rangeBars: 10, atrPeriod: 5 } }),
    PAPER_CORE_JOURNAL: path.join(dir, 'events.jsonl'), PAPER_CORE_STATE: path.join(dir, 'state.json'), PAPER_CORE_KILL_FILE: path.join(dir, 'KILL'),
    PAPER_CORE_OWNERSHIP: path.join(dir, 'ownership.jsonl'),
  });
  const journalWriter = new JsonlOwnershipJournal(config.ownershipPath);
  for (const event of overrides.journal ?? []) journalWriter.append(event);
  const logs: string[] = [];
  const application = buildPaperTradingApplication(config, { fetchImpl: server.fetch, binanceSource, lease, log: (line) => logs.push(line), clock: { now: () => T0 } });
  return { application, server, lease, config, logs };
}

test('start takes the account lease, and stop gives it back', async () => {
  const { application, lease } = appWith();
  await application.start();
  try {
    assert.equal(lease.granted.length, 1);
    assert.equal(lease.holders.has('acct'), true);
  } finally {
    await application.stop();
  }
  assert.equal(lease.released.length, 1);
  assert.equal(lease.holders.has('acct'), false);
});

test('a second process cannot start on an account another process holds, and places no order', async () => {
  const lease = new FakeLease();
  lease.holders.set('acct', { label: 'agent pid 42', expiresAt: T0 + 30_000 });
  const { application, server } = appWith({ lease });
  await assert.rejects(() => application.start(), (error: Error) => error instanceof AccountLeaseHeldError && /agent pid 42/.test(error.message));
  assert.equal(server.count('POST', /\/api\/orders$/), 0);
});

test('start refuses an account that holds a position this process does not own, and gives the lease back', async () => {
  const { application, server, lease } = appWith();
  server.live.positions.push({ id: 3, symbol: 'BTCUSDT', side: 'long', quantity: 0.5, avgPrice: 100, leverage: 2 });
  await assert.rejects(() => application.start(), /holds positions this process does not own \(BTCUSDT\)/);
  assert.equal(lease.released.length, 1);
  assert.equal(lease.holders.has('acct'), false);
});

test('start confirms an intent left open by a previous run when the venue shows its order filled', async () => {
  const { application, server } = appWith({ journal: [{ ...intent('cmd_prev'), accountId: 'acct', idempotencyKey: 'pc-prev' }] });
  server.live.orders.push({ id: 7, client_order_id: 'pc-prev', symbol: 'BTCUSDT', side: 'buy', status: 'filled', quantity: 0.5, filled_quantity: 0.5 });
  server.live.positions.push({ id: 3, symbol: 'BTCUSDT', side: 'long', quantity: 0.5, avgPrice: 100, leverage: 2 });
  await application.start();
  try {
    assert.deepEqual([application.ownership.get('cmd_prev')?.state, application.ownership.get('cmd_prev')?.slotId], ['OWNED', 3]);
  } finally {
    await application.stop();
  }
});

test('start abandons an intent the venue has no order for', async () => {
  const { application } = appWith({ journal: [{ ...intent('cmd_gone'), accountId: 'acct', idempotencyKey: 'pc-gone' }] });
  await application.start();
  try {
    assert.equal(application.ownership.get('cmd_gone')?.state, 'ABANDONED');
  } finally {
    await application.stop();
  }
});

test('start refuses to run while an intent is still open on the venue, and releases the lease', async () => {
  const { application, server, lease } = appWith({ journal: [{ ...intent('cmd_open'), accountId: 'acct', idempotencyKey: 'pc-open' }] });
  server.live.orders.push({ id: 8, client_order_id: 'pc-open', symbol: 'BTCUSDT', side: 'buy', status: 'open', quantity: 0.5, filled_quantity: 0 });
  await assert.rejects(() => application.start(), /refusing to start: cmd_open: the venue order could not be read/);
  assert.equal(lease.holders.has('acct'), false, 'the lease is released when startup fails');
});

// --- Configuration: accounts and their state -----------------------------------------------------------------------

test('each account has its own default state, and research may not run on the trading account', () => {
  const config = validatePaperOnlyConfig({ PAPER_EXCHANGE_URL: 'http://x', PAPER_EXCHANGE_ACCOUNT_ID: 'desk-7' });
  assert.equal(config.statePath, 'data/accounts/desk-7/state.json');
  assert.equal(config.ownershipPath, 'data/accounts/desk-7/ownership.jsonl');
  assert.equal(config.researchAccountId, 'research-admin');
  assert.equal(config.leaseTtlSeconds, 30);
  assert.throws(() => validatePaperOnlyConfig({ PAPER_EXCHANGE_URL: 'http://x', PAPER_EXCHANGE_ACCOUNT_ID: 'desk-7', PAPER_CORE_RESEARCH_ACCOUNT_ID: 'desk-7' }), /must not be the trading account/);
  assert.throws(() => validatePaperOnlyConfig({ PAPER_EXCHANGE_URL: 'http://x', PAPER_EXCHANGE_ACCOUNT_ID: 'desk/7' }), /letters, digits/);
  assert.throws(() => validatePaperOnlyConfig({ PAPER_EXCHANGE_URL: 'http://x', PAPER_EXCHANGE_ACCOUNT_ID: 'desk-7', PAPER_CORE_LEASE_TTL_SECONDS: '5' }), /PAPER_CORE_LEASE_TTL_SECONDS/);
});

// --- The lease adapter's answers -----------------------------------------------------------------------------------

test('a granted lease is returned with its holder and fence, and a held lease names its holder and expiry', async () => {
  const granted = new PaperExchangeLeaseAdapter({
    baseUrl: 'http://paper.test', ttlSeconds: 30,
    fetchImpl: (async () => new Response(JSON.stringify({ holder_id: 'h-1', fence: 4, expires_at: '2026-01-05T00:00:30.000Z' }), { status: 201 })) as typeof fetch,
  });
  const handle = await granted.acquire('acct', 'me');
  assert.deepEqual([handle.holderId, handle.fence, handle.expiresAt], ['h-1', 4, Date.parse('2026-01-05T00:00:30.000Z')]);

  const held = new PaperExchangeLeaseAdapter({
    baseUrl: 'http://paper.test', ttlSeconds: 30,
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'lease_held', holder_label: 'agent pid 9', expires_at: '2026-01-05T00:00:30.000Z' }), { status: 409 })) as typeof fetch,
  });
  await assert.rejects(() => held.acquire('acct', 'me'), (error: Error) => error instanceof AccountLeaseHeldError && error.holderLabel === 'agent pid 9' && error.expiresAt === Date.parse('2026-01-05T00:00:30.000Z'));

  const unreachable = new PaperExchangeLeaseAdapter({
    baseUrl: 'http://paper.test', ttlSeconds: 30,
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  });
  await assert.rejects(() => unreachable.acquire('acct', 'me'), /is unreachable/);
});

test('the lease adapter names one holder per adapter, so a retried acquire renews the same lease and release names that holder', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const lease = new PaperExchangeLeaseAdapter({
    baseUrl: 'http://paper.test', ttlSeconds: 30,
    fetchImpl: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      headers.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ holder_id: bodies.at(-1)?.holder_id, fence: 1, expires_at: '2026-01-05T00:00:30.000Z' }), { status: 201 });
    }) as typeof fetch,
  });
  const first = await lease.acquire('acct', 'me');
  const second = await lease.acquire('acct', 'me');
  assert.equal(typeof bodies[0]?.holder_id, 'string');
  assert.equal(bodies[0]?.holder_id, bodies[1]?.holder_id);
  assert.deepEqual([first.holderId, second.holderId], [bodies[0]?.holder_id, bodies[0]?.holder_id]);
  await lease.release(first);
  assert.deepEqual([headers[2]?.['X-Lease-Holder'], headers[2]?.['X-Lease-Fence']], [first.holderId, '1']);
});
