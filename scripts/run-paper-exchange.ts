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

// Reuse the existing cockpit, agents, risk gates, Ollama advisor and PaperExchange broker.
await import('../src/index.js');
