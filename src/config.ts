import 'dotenv/config';
import { z } from 'zod';
import type { Mode } from './types.js';

const EnvSchema = z.object({
  MODE: z.enum(['paper', 'live']).default('paper'),
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  OLLAMA_HOST: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1:8b'),
  MAX_LEVERAGE: z.coerce.number().default(3),
  MAX_EXPOSURE_PCT: z.coerce.number().default(80),
  RISK_PER_TRADE_PCT: z.coerce.number().default(1),
  MAX_DRAWDOWN_PCT: z.coerce.number().default(5),
  MIN_LIQ_BUFFER_ATR: z.coerce.number().default(2),
  SYMBOLS: z.string().default('BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT'),
});

const env = EnvSchema.parse(process.env);

export const config = {
  mode: env.MODE as Mode,
  binance: { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET },
  ollama: { host: env.OLLAMA_HOST, model: env.OLLAMA_MODEL },
  risk: {
    maxLeverage: env.MAX_LEVERAGE,
    maxExposurePct: env.MAX_EXPOSURE_PCT,
    riskPerTradePct: env.RISK_PER_TRADE_PCT,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    minLiqBufferAtr: env.MIN_LIQ_BUFFER_ATR,
  },
  symbols: env.SYMBOLS.split(',').map(s => s.trim()),
} as const;

if (config.mode === 'live' && (!config.binance.apiKey || !config.binance.apiSecret)) {
  throw new Error('LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
}
