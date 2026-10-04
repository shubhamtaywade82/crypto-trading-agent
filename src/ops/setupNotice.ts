import type { SetupMap } from '../decision/SetupEngine.js';
import type { AlertClass, AlertSeverity } from './alerts.js';
import { setupMapCard } from './setupCards.js';

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
  // Eligibility and thesis flips are material even when the setup state is unchanged, so they must not dedupe against the earlier notice
  const eligible = setup.scenarios.some((scenario) => scenario.quality?.verdict === 'ENTRY_ELIGIBLE');
  const flip = setup.thesisTransition ? `:flip-${setup.thesisTransition.to}` : '';
  return {
    cls: 'SETUP',
    severity: setup.state === 'TRIGGERED' ? 'SIGNAL' : 'WATCH',
    symbol: setup.symbol,
    stateTo: setup.state,
    scenarioKey,
    fingerprint: `SETUP:${setup.symbol}:${setup.state === 'TRIGGERED' ? 'triggered' : scenarioKey}${eligible ? ':eligible' : ''}${flip}`,
    html: setupMapCard(setup),
  };
}
