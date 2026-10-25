/**
 * Headless options book: the same OptionsDesk the cockpit runs beside futures (`npm run dev:paper`), without the TUI
 * or the futures fleet. See docs/OPTIONS_BUYING.md.
 *
 *   npm run options:run                                    # MODE=paper -> local options book
 *   MODE=paper PAPER_EXCHANGE_URL=... PAPER_EXCHANGE_ACCOUNT_ID=acc npm run options:run   # paper_exchange, wallet acc-options
 *   MODE=live npm run options:run                          # monitor: signals and alerts only
 */
import 'dotenv/config';
import { ZodError } from 'zod';
import { optionsConfigFromEnv, type OptionsConfig } from '../src/options/config.js';
import { OptionsDesk } from '../src/options/OptionsDesk.js';
import type { LogLevel } from '../src/options/OptionsBuyingEngine.js';
import { KillSwitch } from '../src/ops/killSwitch.js';

function log(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [options] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

async function main(): Promise<void> {
  let cfg: OptionsConfig;
  try {
    cfg = optionsConfigFromEnv(process.env);
  } catch (err) {
    log('error', `configuration refused: ${err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : (err as Error).message}`);
    process.exit(1);
  }
  if (!cfg.enabled) {
    log('error', 'OPTIONS=off: nothing to run');
    process.exit(1);
  }
  // Loaded lazily: src/config.ts (which the advisor reads) validates the cockpit's own env at import.
  const vetoer = cfg.llmVeto ? new (await import('../src/ollama/advisor.js')).OllamaAdvisor() : null;
  const desk = new OptionsDesk({ config: cfg, killSwitch: new KillSwitch(), vetoer, log });
  log('info', `venue ${cfg.venue}, underlyings ${cfg.underlyings.join(', ')}`);

  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let lastStatus = '';
  while (running) {
    const started = Date.now();
    await desk.tick();
    const view = desk.view();
    const status = view.rows.map((s) => {
      const pos = s.position ? ` ${s.position.qty} ${s.position.symbol} entry ${s.position.entry.toFixed(4)} SL ${s.position.stop.toFixed(4)} TP ${s.position.target.toFixed(4)}` : '';
      return `${s.underlying.padEnd(8)} ${s.state.padEnd(15)}${pos} ${s.note}`;
    }).join('\n');
    if (status !== lastStatus) {
      console.log(`--- ${new Date().toISOString()} ${view.venue} ${view.state} equity ${view.equity?.toFixed(2) ?? '-'} USDT${view.halt ? ` | HALT: ${view.halt}` : ''}\n${status}`);
      lastStatus = status;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, cfg.loopMs - (Date.now() - started))));
  }
  log('info', 'stopped; open positions stay on the venue and are reconciled on the next start');
}

main().catch((err) => {
  log('error', (err as Error).stack ?? String(err));
  process.exit(1);
});
