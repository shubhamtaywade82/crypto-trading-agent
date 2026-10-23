/**
 * Verifies the live Binance USD-M path against the testnet. Read-only by default: it checks the response shapes the bot
 * parses, then runs the startup path (symbol rules, journal, reconciliation, user-data stream). With --place-orders it
 * also sends orders on the testnet: a resting entry that is cancelled, a protected fill whose stop is moved and that is
 * then closed, and a stop the venue refuses, which must end with the position flat.
 *
 *   MODE=live ALERT_ONLY=off BINANCE_TESTNET=on BINANCE_API_KEY=... BINANCE_API_SECRET=... \
 *     npx tsx scripts/binance-testnet-verify.ts [--place-orders]
 *
 * It refuses to run unless BINANCE_TESTNET=on, so it can never reach production. Testnet keys come from
 * testnet.binancefuture.com; the account must be in One-way mode.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { USDMClient } from 'binance';
import { config } from '../src/config.js';
import { BinanceService } from '../src/binance/client.js';
import { ENTRY_ORDER_PREFIX } from '../src/binance/liveProtection.js';
import { getSymbolRules, roundPrice, roundQty, roundStopPrice } from '../src/binance/symbolRules.js';

if (!config.binance.testnet || config.mode !== 'live' || config.alertOnly) {
  console.error('refusing to run: needs MODE=live, ALERT_ONLY=off and BINANCE_TESTNET=on');
  process.exit(2);
}

const placeOrders = process.argv.includes('--place-orders');
const symbol = config.symbols[0];
const strategy = 'MOMENTUM-γ' as const;
const leverage = 5;
const futures = new USDMClient({ api_key: config.binance.apiKey, api_secret: config.binance.apiSecret }, undefined, true);
const service = new BinanceService(null, futures, mkdtempSync(path.join(tmpdir(), 'binance-verify-')));

const venueLog: string[] = [];
service.setEntryLog((message, level) => {
  if (level !== 'info') venueLog.push(message);
  console.log(`      [${level}] ${message}`);
});

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check(name: string, body: () => Promise<string>): Promise<void> {
  let result: Result;
  try {
    result = { name, ok: true, detail: await body() };
  } catch (err) {
    result = { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${name}: ${result.detail}`);
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const protectionOrders = async () => (await futures.getAllOpenOrders({ symbol })).filter((o) => o.closePosition);
const positionOf = async () => (await service.getPositions()).find((p) => p.symbol === symbol);

async function readOnlyChecks(): Promise<void> {
  await check('one-way position mode', async () => {
    const mode = await futures.getCurrentPositionMode();
    expect(mode.dualSidePosition === false, 'dualSidePosition is on; set the testnet account to One-way mode');
    return 'one-way';
  });

  await check('position rows carry the numeric fields the bot parses', async () => {
    const rows = await futures.getPositionsV3();
    for (const row of rows) {
      for (const value of [row.positionAmt, row.entryPrice, row.markPrice, row.unRealizedProfit, row.liquidationPrice]) {
        expect(Number.isFinite(Number(value)), `${row.symbol} has a non-numeric field: ${value}`);
      }
    }
    return `${rows.length} row(s)`;
  });

  await check('account reports margin balance and an isolated flag per position', async () => {
    const info = await futures.getAccountInformation();
    expect(Number.isFinite(Number(info.totalMarginBalance)), 'totalMarginBalance is not numeric');
    for (const p of info.positions) expect(typeof p.isolated === 'boolean', `${p.symbol} has no isolated flag`);
    return `margin balance ${info.totalMarginBalance}`;
  });

  await check('leverage brackets for every configured symbol', async () => {
    const counts: string[] = [];
    for (const sym of config.symbols) {
      const row = (await futures.getNotionalAndLeverageBrackets({ symbol: sym })).find((r) => r.symbol === sym);
      expect(row !== undefined && row.brackets.length > 0, `${sym}: no brackets returned`);
      for (const b of row.brackets) {
        const numeric = [b.notionalFloor, b.notionalCap, b.maintMarginRatio, b.cum, b.initialLeverage].every((v) => Number.isFinite(Number(v)));
        expect(numeric, `${sym}: bracket ${b.bracket} has a non-numeric field`);
      }
      counts.push(`${sym} ${row.brackets.length}`);
    }
    return counts.join(', ');
  });

  await check('account trades and funding income endpoints', async () => {
    const trades = await futures.getAccountTrades({ symbol, limit: 5 });
    const income = await futures.getIncomeHistory({ incomeType: 'FUNDING_FEE', limit: 5 });
    expect(Array.isArray(trades) && Array.isArray(income), 'an endpoint did not return a list');
    return `${trades.length} trade(s), ${income.length} funding line(s)`;
  });

  await check('startup path: symbol rules, journal, reconciliation, user-data stream', async () => {
    await service.loadSymbolRules(config.symbols);
    await service.refreshLiveState(config.symbols);
    expect(service.journalReady(), 'the trade journal did not sync');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const streamProblems = venueLog.filter((m) => m.includes('user data stream'));
    expect(streamProblems.length === 0, `user-data stream: ${streamProblems.join(' | ')}`);
    const blocked = config.symbols.map((s) => service.entryBlockReason(s)).filter((b): b is string => b !== undefined);
    expect(blocked.length === 0, `entries blocked: ${blocked.join(' | ')}`);
    return 'journal synced, stream up, no entry blocks';
  });
}

async function orderChecks(): Promise<void> {
  const { markPrice } = await service.getPremiumIndex(symbol);
  const rules = getSymbolRules(symbol);
  // A generous notional floor clears testnet minimums; the quantity rounds up to the lot step
  const qtyAt = (price: number): number => roundQty(symbol, Math.max(rules.minQty, Math.max(rules.minNotional, 20) / price) + rules.stepSize);

  await check('resting entry rests under a bot client id and cancels', async () => {
    const limit = roundPrice(symbol, markPrice * 0.5);
    await service.openFuturesPosition({ symbol, side: 'BUY', qty: qtyAt(limit), leverage, strategy, entryPrice: limit, stopLoss: roundPrice(symbol, limit * 0.9) });
    const resting = (await futures.getAllOpenOrders({ symbol })).find((o) => o.type === 'LIMIT' && o.clientOrderId.startsWith(ENTRY_ORDER_PREFIX));
    expect(resting !== undefined, 'the entry did not rest under a bot client id');
    const cancelled = await service.cancelEntryOrders();
    expect(cancelled >= 1, `cancelEntryOrders cancelled ${cancelled}`);
    const after = await futures.getOrder({ symbol, origClientOrderId: resting.clientOrderId });
    expect(after.status === 'CANCELED', `order status is ${after.status} after cancel`);
    await new Promise((resolve) => setTimeout(resolve, 3_000)); // the entry tracker polls once a second
    return `client id ${resting.clientOrderId}, status ${after.status}`;
  });

  await check('protected fill: stop and target rest, the stop moves, the position closes flat', async () => {
    const fill = roundPrice(symbol, markPrice * 1.01);
    const target = roundPrice(symbol, markPrice * 1.2);
    await service.openFuturesPosition({ symbol, side: 'BUY', qty: qtyAt(fill), leverage, strategy, entryPrice: fill, stopLoss: roundPrice(symbol, markPrice * 0.9), takeProfit: target });
    await waitFor('the protected position', async () => {
      const pos = await positionOf();
      return pos !== undefined && Number.isFinite(Number(pos.serverSl)) && Number.isFinite(Number(pos.serverTp));
    });
    const legs = await protectionOrders();
    expect(legs.filter((o) => o.type === 'STOP_MARKET').length === 1, `expected one resting stop, found ${legs.length} protective order(s)`);
    expect(legs.filter((o) => o.type === 'TAKE_PROFIT_MARKET').length === 1, 'expected one resting take-profit');

    const moved = roundStopPrice(symbol, markPrice * 0.92, 'SELL');
    const current = await positionOf();
    expect(current !== undefined, 'the position disappeared before the stop move');
    await service.updateStops(symbol, strategy, moved, target, 'LONG');
    await waitFor('the moved stop', async () => {
      const stops = (await protectionOrders()).filter((o) => o.type === 'STOP_MARKET');
      return stops.length === 1 && Number(stops[0].stopPrice) === moved;
    });

    await service.closePosition(current);
    await waitFor('a flat position with no protection left', async () => (await positionOf()) === undefined && (await protectionOrders()).length === 0);
    return `stop moved to ${moved}, closed flat`;
  });

  await check('a stop the venue refuses ends with the position closed, not left open', async () => {
    const fill = roundPrice(symbol, markPrice * 1.01);
    // A long's stop above the market would trigger at once: the venue refuses it, and the bot must flatten
    await service.openFuturesPosition({ symbol, side: 'BUY', qty: qtyAt(fill), leverage, strategy, entryPrice: fill, stopLoss: roundPrice(symbol, markPrice * 1.05) });
    await waitFor('the refused stop to be closed out', async () => (await positionOf()) === undefined);
    expect((await protectionOrders()).length === 0, 'protective orders remain after the close');
    const refused = venueLog.some((m) => m.includes('Protection order failed'));
    return refused ? 'venue refused the stop; position flattened' : 'stop accepted and triggered; position flattened (refusal path not exercised)';
  });
}

async function main(): Promise<void> {
  console.log(`Binance testnet verification on ${symbol}${placeOrders ? ' (placing testnet orders)' : ' (read-only)'}`);
  await readOnlyChecks();
  if (placeOrders) {
    try {
      await orderChecks();
    } finally {
      await service.cancelAllResting().catch((err: unknown) => console.log(`cleanup: cancel failed: ${String(err)}`));
      const leftover = await positionOf();
      if (leftover) await service.closePosition(leftover).catch((err: unknown) => console.log(`cleanup: close failed: ${String(err)}`));
    }
  } else {
    console.log('read-only checks complete; re-run with --place-orders to exercise the order flow on the testnet');
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`verification aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
