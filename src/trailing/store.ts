import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode } from '../types.js';
import type { TrailingState } from './types.js';

/**
 * Persistence for trailing books (spec §5, modelled after PositionManagerStore): atomic tmp+rename
 * writes, separate books per account mode, corrupt files tolerated. Material changes flush
 * immediately (a crash must never lose an exit intent); extreme-only updates throttle to a window.
 */

interface TrailingFile {
  version: 1;
  modes: Partial<Record<Mode, Record<string, TrailingState>>>;
}

const EXTREME_FLUSH_MS = 5_000;

// favorableExtremeX/peakNetPnl/mfe/mae are deliberately absent: they are the throttled path.
const MATERIAL_KEYS: readonly (keyof TrailingState)[] = [
  'stopZ', 'confirmedStop', 'phase', 'policyId', 'reducedQty', 'entry', 'liquidationPrice',
  'fundingAccrued', 'feesAccrued',
];

function isStateMap(value: unknown): value is Record<string, TrailingState> {
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).every((entry) => {
    const st = entry as Partial<TrailingState> | null;
    return st !== null && typeof st === 'object' && typeof st.key === 'string' && typeof st.entry === 'number'
      && typeof st.stopZ === 'number' && typeof st.confirmedStop === 'number' && typeof st.initialQty === 'number'
      && typeof st.favorableExtremeX === 'number' && typeof st.phase === 'string'
      && (st.side === 'LONG' || st.side === 'SHORT');
  });
}

function load(filePath: string): TrailingFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as TrailingFile;
    const modes: Partial<Record<Mode, Record<string, TrailingState>>> = {};
    for (const [mode, states] of Object.entries(parsed.modes ?? {})) {
      if (isStateMap(states)) modes[mode as Mode] = states;
    }
    return { version: 1, modes };
  } catch {
    // corrupt or missing file: restart empty rather than take the agent down
    return { version: 1, modes: {} };
  }
}

function acknowledgedChanged(prev: TrailingState, next: TrailingState): boolean {
  const a = prev.lastAcceptedDecision;
  const b = next.lastAcceptedDecision;
  return a?.ts !== b?.ts || a?.stopZ !== b?.stopZ || a?.policyId !== b?.policyId;
}

export class TrailingStateStore {
  private readonly filePath: string;
  private readonly mode: Mode;
  private readonly now: () => number;
  private file: TrailingFile;
  private dirty = false;
  private lastExtremeFlush = 0;

  constructor(mode: Mode, filePath: string, now: () => number = Date.now) {
    this.mode = mode;
    this.filePath = filePath;
    this.now = now;
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.file = load(filePath);
  }

  get(key: string): TrailingState | undefined {
    return this.file.modes[this.mode]?.[key];
  }

  keys(): string[] {
    return Object.keys(this.file.modes[this.mode] ?? {});
  }

  set(state: TrailingState): void {
    const prev = this.get(state.key);
    const states = this.file.modes[this.mode] ?? {};
    states[state.key] = state;
    this.file.modes[this.mode] = states;
    if (prev === undefined || MATERIAL_KEYS.some((k) => prev[k] !== state[k]) || acknowledgedChanged(prev, state)) {
      this.flush();
    } else if (prev.favorableExtremeX !== state.favorableExtremeX) {
      this.dirty = true;
    }
  }

  delete(key: string): void {
    const states = this.file.modes[this.mode];
    if (states === undefined || !(key in states)) return;
    delete states[key];
    this.flush();
  }

  tick(): void {
    if (!this.dirty || this.now() - this.lastExtremeFlush < EXTREME_FLUSH_MS) return;
    this.flush();
  }

  flush(): void {
    this.dirty = false;
    this.lastExtremeFlush = this.now();
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file));
    renameSync(tmp, this.filePath);
  }
}
