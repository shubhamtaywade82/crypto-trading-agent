import 'dotenv/config';
import { PaperExchangeClient } from '../src/binance/paperExchangeClient.js';
import { PaperExchangeLeaseAdapter } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseAdapter.js';
import { DEFAULT_LEASE_TTL_SECONDS, PaperExchangeLeaseKeeper } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseKeeper.js';
import { FakeExchange } from '../tests/support/fakeExchange.js';
import { SCENARIOS_1_TO_12 } from './e2e-scenarios.js';
import { SCENARIOS_13_TO_24 } from './e2e-scenarios-2.js';
import { assertThrowaway, INITIAL_MARGIN, SkipError, violations, World, type Conn, type Env, type Scenario } from './e2e-world.js';

const SCENARIOS: Scenario[] = [...SCENARIOS_1_TO_12, ...SCENARIOS_13_TO_24];

type Outcome = { status: 'PASS' | 'FAIL' | 'SKIPPED'; detail: string };

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

function fakeEnv(): Env {
  const connect = async (): Promise<Conn> => {
    const fake = new FakeExchange();
    await fake.createAccount(INITIAL_MARGIN);
    return { base: fake, outsider: fake, fake, zeroRows: async (symbol) => fake.allRows().filter((p) => p.symbol === symbol && p.netQuantity === 0).length };
  };
  return { backend: 'fake', accountId: 'e2e-fake', connect, blank: () => new FakeExchange() };
}

/** The lease keeper for one e2e account: it takes the lease before the account's first write and gives it back on close. */
function accountLease(url: string, apiKey: string, accountId: string, label: string, onLost: (reason: string) => void): PaperExchangeLeaseKeeper {
  return new PaperExchangeLeaseKeeper({
    lease: new PaperExchangeLeaseAdapter({ baseUrl: url, apiKey, ttlSeconds: DEFAULT_LEASE_TTL_SECONDS }),
    accountId,
    label,
    ttlSeconds: DEFAULT_LEASE_TTL_SECONDS,
    onLost,
    log: (message) => console.log(`  ${message}`),
  });
}

/**
 * One throwaway account for the whole run, plus a blank one for the scenario that creates accounts. The venue admits one writer
 * per account, so each account's lease is taken before its first write and held until the run ends. The exchange cannot delete
 * accounts, so `e2e-*` rows stay behind.
 */
async function realEnv(): Promise<Env> {
  const url = process.env.PAPER_EXCHANGE_URL?.replace(/\/+$/, '');
  if (!url) throw new Error('E2E_BACKEND=real needs PAPER_EXCHANGE_URL');
  const apiKey = process.env.PAPER_EXCHANGE_API_KEY;
  if (!apiKey) throw new Error('E2E_BACKEND=real needs PAPER_EXCHANGE_API_KEY');
  const accountId = `e2e-${Date.now()}`;
  const blankId = `${accountId}-blank`;
  assertThrowaway(accountId);
  assertThrowaway(blankId);

  let lostReason: string | null = null;
  const onLost = (reason: string): void => {
    lostReason ??= reason;
  };
  const baseLease = accountLease(url, apiKey, accountId, 'e2e-base', onLost);
  const blankLease = accountLease(url, apiKey, blankId, 'e2e-blank', onLost);
  const leases = [baseLease, blankLease];
  const releaseAll = async (): Promise<void> => {
    await Promise.allSettled(leases.map((lease) => lease.stop()));
  };

  try {
    for (const lease of leases) await lease.start();
    const conn: Conn = {
      base: new PaperExchangeClient(url, accountId, { apiKey, lease: baseLease }),
      // Deliberately unleased: an external writer on a leased account is exactly what the venue must refuse.
      outsider: new PaperExchangeClient(url, accountId, { apiKey }),
      fake: null,
      zeroRows: async (symbol) => {
        const response = await fetch(`${url}/api/positions`, { headers: { 'X-Account-Id': accountId, 'X-API-Key': apiKey } });
        if (!response.ok) throw new Error(`GET /api/positions failed: ${response.status}`);
        const rows = (await response.json()) as { symbol: string; net_quantity: string | number }[];
        return rows.filter((row) => row.symbol === symbol && Number(row.net_quantity) === 0).length;
      },
    };
    await conn.base.createAccount(INITIAL_MARGIN);
    return {
      backend: 'real',
      accountId,
      connect: async () => conn,
      blank: () => new PaperExchangeClient(url, blankId, { apiKey, lease: blankLease }),
      close: releaseAll,
      leaseLost: () => lostReason,
    };
  } catch (err) {
    await releaseAll();
    throw err;
  }
}

async function runScenario(env: Env, index: number, scenario: Scenario): Promise<Outcome> {
  const world = new World(env, await env.connect(), index);
  try {
    await world.start();
    await scenario.run(world);
    await world.flatten();
    return { status: 'PASS', detail: world.notes.join('; ') };
  } catch (err) {
    // Whatever the scenario opened is closed before the next one starts, failed or skipped: a leftover position would fail the
    // next scenario's start. The outcome being reported matters more than a cleanup error.
    await world.flatten().catch(() => undefined);
    if (err instanceof SkipError) return { status: 'SKIPPED', detail: `(${err.message}) | compared before the skip: ${world.notes.join('; ')}` };
    return { status: 'FAIL', detail: `${errorText(err)} | compared so far: ${world.notes.join('; ')}` };
  }
}

async function main(): Promise<void> {
  const backend = process.env.E2E_BACKEND ?? 'fake';
  if (backend !== 'fake' && backend !== 'real') throw new Error(`E2E_BACKEND must be fake or real, got ${backend}`);
  const env = backend === 'real' ? await realEnv() : fakeEnv();
  console.log(`E2E backend=${env.backend} account=${env.accountId}`);
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      const outcome = await runScenario(env, index, scenario);
      counts[outcome.status]++;
      console.log(`${outcome.status} ${scenario.id} ${scenario.title} | ${outcome.detail}`);
    }
  } finally {
    await env.close?.();
  }
  const lost = env.leaseLost?.() ?? null;
  console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIPPED} skipped (${SCENARIOS.length} scenarios)`);
  if (violations.length > 0) console.log(`FAIL symbol guard tripped: ${violations.join(',')}`);
  if (lost !== null) console.log(`FAIL a lease was lost during the run, so the run's writes cannot be trusted: ${lost}`);
  const failed = counts.FAIL > 0 || violations.length > 0 || lost !== null;
  process.exitCode = failed ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
