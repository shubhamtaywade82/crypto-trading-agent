/**
 * Long-only crypto options buyer (CE on a bullish read, PE on a bearish one). See docs/OPTIONS_BUYING.md.
 *
 *   OPTIONS_VENUE=local npx tsx scripts/run-options-buyer.ts
 *   OPTIONS_VENUE=paper_exchange PAPER_EXCHANGE_URL=http://localhost:3000 OPTIONS_PAPER_EXCHANGE_ACCOUNT_ID=crypto-options \
 *     PAPER_EXCHANGE_API_KEY=... npx tsx scripts/run-options-buyer.ts
 *   OPTIONS_VENUE=coindcx_monitor npx tsx scripts/run-options-buyer.ts     # signals and alerts only
 *
 * Market data: binance-sdk, read-only (Options chain from eapi, underlying klines from USD-M).
 * AI: the Ollama advisor (ollama-sdk) may veto an entry; it never originates one. OPTIONS_LLM_VETO=off disables it.
 * Kill switch: data/kill-switch.json (shared with the cockpit) halts new option entries; exits keep running.
 */
import 'dotenv/config';
import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { optionsConfigFromEnv, type OptionsConfig } from '../src/options/config.js';
import { OptionChainService, sdkOptionsSource } from '../src/options/OptionChainService.js';
import { OptionsBuyingEngine, type LogLevel } from '../src/options/OptionsBuyingEngine.js';
import { OptionsJournal, OptionsStateStore } from '../src/options/stateStore.js';
import { SdkUnderlyingContextSource, sdkKlineReader } from '../src/options/UnderlyingContext.js';
import { LocalOptionsPaperVenue, MonitorOnlyVenue, PaperExchangeOptionsVenue, type OptionsVenue } from '../src/options/venues.js';
import { KillSwitch } from '../src/ops/killSwitch.js';

function log(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [options] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

async function venueFor(cfg: OptionsConfig): Promise<OptionsVenue> {
  switch (cfg.venue) {
    case 'local':
      return new LocalOptionsPaperVenue(cfg.localEquity, cfg.fees);
    case 'paper_exchange': {
      const pe = cfg.paperExchange!;
      const venue = new PaperExchangeOptionsVenue(pe.url, pe.accountId, cfg.fees, { apiKey: pe.apiKey });
      await venue.ensureAccount(cfg.localEquity);
      return venue;
    }
    case 'coindcx_monitor':
      return new MonitorOnlyVenue('coindcx-monitor', cfg.localEquity);
  }
}

async function main(): Promise<void> {
  let cfg: OptionsConfig;
  try {
    cfg = optionsConfigFromEnv(process.env);
  } catch (err) {
    log('error', `configuration refused: ${(err as Error).message}`);
    process.exit(1);
  }

  const client = new BinanceClient({ safety: { readOnly: true } });
  await client.syncTime();
  const rejectedOnce = new Set<string>();
  const chain = new OptionChainService(sdkOptionsSource(client), {
    onRejectedContract: (symbol, reason) => {
      if (rejectedOnce.has(symbol)) return;
      rejectedOnce.add(symbol);
      log('warn', `contract ${symbol} ignored: ${reason}`);
    },
  });
  const venue = await venueFor(cfg);
  // Loaded lazily: src/config.ts (which the advisor reads) validates the cockpit's own env at import.
  const vetoer = cfg.llmVeto ? new (await import('../src/ollama/advisor.js')).OllamaAdvisor() : null;

  const engine = new OptionsBuyingEngine({
    config: cfg,
    chain,
    context: new SdkUnderlyingContextSource(sdkKlineReader(client)),
    venue,
    vetoer,
    killSwitch: new KillSwitch(),
    store: new OptionsStateStore(cfg.statePath),
    journal: new OptionsJournal(cfg.journalPath),
    log,
  });
  await engine.start();

  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let lastStatus = '';
  while (running) {
    const started = Date.now();
    try {
      await engine.cycle();
    } catch (err) {
      log('error', `cycle failed: ${(err as Error).message}`);
    }
    const status = engine.status().map((s) => {
      const pos = s.position ? ` ${s.position.qty} ${s.position.symbol} entry ${s.position.entry.toFixed(4)} SL ${s.position.stop.toFixed(4)} TP ${s.position.target.toFixed(4)}` : '';
      return `${s.underlying.padEnd(8)} ${s.state.padEnd(15)}${pos} ${s.note}`;
    }).join('\n');
    if (status !== lastStatus) {
      console.log(`--- ${new Date().toISOString()} ${venue.name} equity ${(await venue.equity().catch(() => NaN)).toFixed(2)} USDT${engine.riskHalt() ? ` | HALT: ${engine.riskHalt()}` : ''}\n${status}`);
      lastStatus = status;
    }
    const wait = Math.max(0, cfg.loopMs - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  client.closeAllWebSockets();
  log('info', 'stopped; open positions stay on the venue and are reconciled on the next start');
}

main().catch((err) => {
  log('error', (err as Error).stack ?? String(err));
  process.exit(1);
});
