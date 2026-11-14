#!/usr/bin/env node
import 'dotenv/config';
import { assertPaperExchangeOnly } from '../src/runtime/paperExchangeOnly.js';

// Never silently turn a requested live configuration into a paper session.
const configuredMode = process.env.MODE?.trim();
if (configuredMode && configuredMode !== 'paper') {
  throw new Error('dev:paper-exchange refuses MODE other than paper.');
}

process.env.MODE = 'paper';
process.env.PAPER_EXCHANGE_URL ||= 'http://127.0.0.1:3100';

const { config } = await import('../src/config.js');

assertPaperExchangeOnly({
  mode: config.mode,
  binanceTestnet: config.binance.testnet,
  paperExchange: config.paperExchange,
});

const healthUrl = `${config.paperExchange!.url.replace(/\\/+$/, '')}/up`;
let health: Response;
try {
  health = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
} catch (error) {
  throw new Error(
    `PaperExchange is unreachable at ${healthUrl}; start the service before starting the agent.`,
    { cause: error },
  );
}
if (!health.ok) {
  throw new Error(`PaperExchange health check failed: GET ${healthUrl} returned HTTP ${health.status}.`);
}

// Reuse the existing cockpit, agents, risk gates, Ollama advisor and PaperExchange broker.
await import('../src/index.js');
