import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseRefusedError, LeaseRequiredError, OrderRejectedError, PaperExchangeClient, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { PaperExchangeLeaseAdapter } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseAdapter.js';
import { PaperExchangeLeaseKeeper } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseKeeper.js';
import { AccountLeaseHeldError, AccountLeaseLostError, type AccountLeaseHandle, type AccountLeasePort } from '../src/core/ports/AccountLeasePort.js';

const ACCOUNT = 'ACC-LEASE';
const TTL = 30;
const ORDER: SubmitOrderParams = { symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, leverage: 10, executionPrice: 65000, clientOrderId: 'abc-123' };

/** The venue's lease rules on a clock the test controls: one holder, a fence that rises on every grant, and expiry. */
class VenueLeases implements AccountLeasePort {
  holder: { holderId: string; fence: number; label: string; expiresAt: number } | null = null;
  renewals = 0;
  releases = 0;
  failRenewals = false;
  private fenceCounter = 0;

  constructor(private readonly clock: { now: number }) {}

  async acquire(accountId: string, label: string): Promise<AccountLeaseHandle> {
    if (this.holder && this.holder.expiresAt > this.clock.now) {
      throw new AccountLeaseHeldError(`account ${accountId} is leased by ${this.holder.label}`, this.holder.label, this.holder.expiresAt);
    }
    this.fenceCounter += 1;
    this.holder = { holderId: `holder-${this.fenceCounter}`, fence: this.fenceCounter, label, expiresAt: this.clock.now + TTL * 1000 };
    return this.handleFor(accountId);
  }

  async renew(handle: AccountLeaseHandle, ttlSeconds: number): Promise<AccountLeaseHandle> {
    if (this.failRenewals) throw new Error('connection reset');
    this.renewals += 1;
    const held = this.holder;
    if (!held || held.holderId !== handle.holderId || held.fence !== handle.fence || held.expiresAt <= this.clock.now) {
      throw new AccountLeaseLostError(`the lease for ${handle.accountId} is not held under fence ${handle.fence}`);
    }
    held.expiresAt = this.clock.now + ttlSeconds * 1000;
    return this.handleFor(handle.accountId);
  }

  async release(handle: AccountLeaseHandle): Promise<void> {
    this.releases += 1;
    if (this.holder?.holderId === handle.holderId && this.holder.fence === handle.fence) this.holder = null;
  }

  /** Another process takes the account under a higher fence. */
  takeOver(): void {
    this.fenceCounter += 1;
    this.holder = { holderId: `intruder-${this.fenceCounter}`, fence: this.fenceCounter, label: 'intruder', expiresAt: this.clock.now + TTL * 1000 };
  }

  private handleFor(accountId: string): AccountLeaseHandle {
    const held = this.holder;
    if (!held) throw new Error('the venue has no grant');
    return { accountId, holderId: held.holderId, fence: held.fence, expiresAt: held.expiresAt };
  }
}

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** A venue reached over fetch: `reply` answers each request from its method and path. */
function venueFetch(reply: (method: string, path: string) => { status: number; json?: unknown }, seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(init?.method);
    const path = new URL(String(url)).pathname;
    seen.push({ method, path, headers: (init?.headers as Record<string, string>) ?? {} });
    const answer = reply(method, path);
    return new Response(JSON.stringify(answer.json ?? ''), { status: answer.status });
  }) as typeof fetch;
}

function keeperFor(venue: VenueLeases, clock: { now: number }, extra: { onLost?: (reason: string) => void; log?: (message: string) => void } = {}) {
  return new PaperExchangeLeaseKeeper({
    lease: venue, accountId: ACCOUNT, label: 'rspec', ttlSeconds: TTL,
    renewEveryMs: 1_000_000_000, safetyMarginMs: 1000, now: () => clock.now, ...extra,
  });
}

test('a started keeper signs each write with its holder and fence, and refuses writes before it holds a lease', async () => {
  const clock = { now: 0 };
  const keeper = keeperFor(new VenueLeases(clock), clock);
  assert.throws(() => keeper.writeHeaders(), LeaseRequiredError);
  try {
    await keeper.start();
    assert.deepEqual(keeper.writeHeaders(), { 'X-Lease-Holder': 'holder-1', 'X-Lease-Fence': '1' });
  } finally {
    await keeper.stop();
  }
});

test('a renewal moves the local deadline, so writes keep landing while the lease is renewed', async () => {
  const clock = { now: 0 };
  const venue = new VenueLeases(clock);
  const keeper = keeperFor(venue, clock);
  try {
    await keeper.start(); // local deadline 29 s
    clock.now = 20_000;
    await keeper.renew(); // venue live until 50 s; local deadline now 49 s
    clock.now = 40_000; // past the first deadline, inside the second
    assert.equal(keeper.status, 'held');
    assert.equal(keeper.writeHeaders()['X-Lease-Fence'], '1');
    assert.equal(venue.renewals, 1);
  } finally {
    await keeper.stop();
  }
});

test('a deadline missed without a renewal refuses writes and reports the loss once', async () => {
  const clock = { now: 0 };
  const lost: string[] = [];
  const keeper = keeperFor(new VenueLeases(clock), clock, { onLost: (reason) => lost.push(reason) });
  try {
    await keeper.start();
    clock.now = 29_000; // the local deadline
    assert.throws(() => keeper.writeHeaders(), LeaseRequiredError);
    assert.throws(() => keeper.writeHeaders(), LeaseRequiredError);
    assert.equal(keeper.status, 'lost');
    assert.equal(lost.length, 1);
    assert.match(lost[0], /ran out/);
  } finally {
    await keeper.stop();
  }
});

test('a renewal the venue refuses marks the lease lost, and no write follows', async () => {
  const clock = { now: 0 };
  const venue = new VenueLeases(clock);
  const lost: string[] = [];
  const keeper = keeperFor(venue, clock, { onLost: (reason) => lost.push(reason) });
  try {
    await keeper.start();
    clock.now = 5_000;
    venue.takeOver();
    await keeper.renew();
    assert.equal(keeper.status, 'lost');
    assert.equal(lost.length, 1);
    assert.throws(() => keeper.writeHeaders(), LeaseRequiredError);
  } finally {
    await keeper.stop();
  }
});

test('a renewal that fails for a transient reason keeps the lease until its deadline', async () => {
  const clock = { now: 0 };
  const venue = new VenueLeases(clock);
  const logs: string[] = [];
  const keeper = keeperFor(venue, clock, { log: (message) => logs.push(message) });
  try {
    await keeper.start();
    venue.failRenewals = true;
    clock.now = 10_000;
    await keeper.renew();
    assert.equal(keeper.status, 'held');
    assert.equal(keeper.writeHeaders()['X-Lease-Fence'], '1');
    assert.match(logs.join('\n'), /renewing ACC-LEASE failed; retrying: connection reset/);
    venue.failRenewals = false;
    clock.now = 20_000;
    await keeper.renew(); // succeeds: the local deadline moves to 49 s
    clock.now = 45_000;
    assert.equal(keeper.status, 'held');
    assert.equal(keeper.writeHeaders()['X-Lease-Holder'], 'holder-1');
  } finally {
    await keeper.stop();
  }
});

test('startup refuses while another process holds the account, and the refused keeper never writes', async () => {
  const clock = { now: 0 };
  const venue = new VenueLeases(clock);
  const first = keeperFor(venue, clock);
  const second = keeperFor(venue, clock);
  try {
    await first.start();
    await assert.rejects(() => second.start(), AccountLeaseHeldError);
    assert.equal(second.status, 'idle');
    assert.throws(() => second.writeHeaders(), LeaseRequiredError);
  } finally {
    await first.stop();
    await second.stop();
  }
});

test('stop gives the lease back and refuses every later write', async () => {
  const clock = { now: 0 };
  const venue = new VenueLeases(clock);
  const keeper = keeperFor(venue, clock);
  await keeper.start();
  await keeper.stop();
  assert.equal(venue.releases, 1);
  assert.equal(venue.holder, null);
  assert.equal(keeper.status, 'released');
  assert.throws(() => keeper.writeHeaders(), LeaseRequiredError);
});

test('a client with a lease that is not held refuses the write without sending anything', async () => {
  const clock = { now: 0 };
  const keeper = keeperFor(new VenueLeases(clock), clock);
  const seen: Seen[] = [];
  const client = new PaperExchangeClient('http://paper.test', ACCOUNT, {
    fetchImpl: venueFetch(() => ({ status: 201, json: {} }), seen), retries: 2, backoffMs: 1, lease: keeper,
  });
  await assert.rejects(() => client.submitOrder(ORDER), LeaseRequiredError);
  assert.equal(seen.length, 0);
});

test('a leased client fences its writes and sends reads without lease headers', async () => {
  const clock = { now: 0 };
  const keeper = keeperFor(new VenueLeases(clock), clock);
  const seen: Seen[] = [];
  const client = new PaperExchangeClient('http://paper.test', ACCOUNT, {
    fetchImpl: venueFetch((method) => (method === 'GET' ? { status: 200, json: [] } : { status: 201, json: { id: 1, status: 'filled', filled_quantity: 0.01 } }), seen),
    retries: 0, lease: keeper,
  });
  try {
    await keeper.start();
    await client.getPositions();
    await client.submitOrder(ORDER);
    assert.equal(seen[0].headers['X-Lease-Holder'], undefined);
    assert.deepEqual([seen[1].headers['X-Lease-Holder'], seen[1].headers['X-Lease-Fence']], ['holder-1', '1']);
  } finally {
    await keeper.stop();
  }
});

test('a venue 409 lease_lost is a LeaseRefusedError, is not retried, and stops every later write', async () => {
  const clock = { now: 0 };
  const keeper = keeperFor(new VenueLeases(clock), clock);
  const seen: Seen[] = [];
  const client = new PaperExchangeClient('http://paper.test', ACCOUNT, {
    fetchImpl: venueFetch(() => ({ status: 409, json: { error: 'lease_lost', message: 'stale fence' } }), seen), retries: 2, backoffMs: 1, lease: keeper,
  });
  try {
    await keeper.start();
    await assert.rejects(() => client.submitOrder(ORDER), (error: Error) => error instanceof LeaseRefusedError && error.code === 'lease_lost');
    assert.equal(seen.length, 1);
    assert.equal(keeper.status, 'lost');
    await assert.rejects(() => client.submitOrder(ORDER), LeaseRequiredError);
    assert.equal(seen.length, 1);
  } finally {
    await keeper.stop();
  }
});

test('a 409 that is not a lease refusal stays an ordinary rejection and leaves the lease held', async () => {
  const clock = { now: 0 };
  const keeper = keeperFor(new VenueLeases(clock), clock);
  const seen: Seen[] = [];
  const client = new PaperExchangeClient('http://paper.test', ACCOUNT, {
    fetchImpl: venueFetch(() => ({ status: 409, json: { error: 'run is completed; reset it' } }), seen), retries: 0, lease: keeper,
  });
  try {
    await keeper.start();
    await assert.rejects(() => client.submitOrder(ORDER), OrderRejectedError);
    assert.equal(keeper.status, 'held');
  } finally {
    await keeper.stop();
  }
});

test('the lease adapter renews under the fence it holds, and the venue refusing that fence is a lost lease', async () => {
  const seen: Seen[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(init?.method);
    const headers = (init?.headers as Record<string, string>) ?? {};
    seen.push({ method, path: new URL(String(url)).pathname, headers });
    if (method === 'POST') return json(201, { holder_id: 'h-1', fence: 3, expires_at: '2026-01-05T00:00:30.000Z' });
    if (headers['X-Lease-Holder'] === 'h-1' && headers['X-Lease-Fence'] === '3') {
      return json(200, { holder_id: 'h-1', fence: 3, expires_at: '2026-01-05T00:01:00.000Z' });
    }
    return json(409, { error: 'lease_lost', message: 'not held' });
  }) as typeof fetch;
  const adapter = new PaperExchangeLeaseAdapter({ baseUrl: 'http://paper.test', ttlSeconds: 30, fetchImpl });

  const handle = await adapter.acquire(ACCOUNT, 'rspec');
  const renewed = await adapter.renew(handle, 30);

  assert.equal(seen[1].method, 'PUT');
  assert.equal(seen[1].path, '/api/account/lease');
  assert.deepEqual([seen[1].headers['X-Lease-Holder'], seen[1].headers['X-Lease-Fence']], ['h-1', '3']);
  assert.equal(renewed.fence, 3);
  assert.equal(renewed.expiresAt, Date.parse('2026-01-05T00:01:00.000Z'));
  await assert.rejects(() => adapter.renew({ ...handle, fence: 2 }, 30), AccountLeaseLostError);
});
