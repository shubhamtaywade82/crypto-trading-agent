import type { SetupMap } from '../decision/SetupEngine.js';
import type { AlertClass, AlertSeverity } from './alerts.js';

export interface SetupNotice {
  cls: Extract<AlertClass, 'SETUP'>;
  severity: Extract<AlertSeverity, 'WATCH' | 'SIGNAL'>;
  fingerprint: string;
  html: string;
  symbol: string;
  stateTo: string;
  scenarioKey: string;
}

export function buildSetupNotice(setup: SetupMap): SetupNotice | null {
  if (setup.scenarios.length === 0) return null;
  const scenarioKey = setup.scenarios.map((scenario) => scenario.id).sort().join(',');
  return {
    cls: 'SETUP',
    severity: setup.state === 'TRIGGERED' ? 'SIGNAL' : 'WATCH',
    symbol: setup.symbol,
    stateTo: setup.state,
    scenarioKey,
    fingerprint: `SETUP:${setup.symbol}:${setup.state === 'TRIGGERED' ? 'triggered' : scenarioKey}`,
    html: requireSetupCard(setup),
  };
}

function requireSetupCard(setup: SetupMap): string {
  // Kept as a small indirection so setup notice construction stays independent from Telegram formatting details.
  return setupCard(setup);
}

import { setupMapCard as setupCard } from './setupCards.js';
