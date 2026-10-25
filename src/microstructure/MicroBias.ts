export type Bias = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface BiasOptions {
  /** A new LONG/SHORT must be proposed continuously for this long before it is adopted. */
  confirmMs: number;
  /** A held bias must lose its support continuously for this long before it falls back to NEUTRAL. */
  releaseMs: number;
}

export const DEFAULT_BIAS_OPTIONS: BiasOptions = { confirmMs: 10_000, releaseMs: 30_000 };

export interface BiasState {
  bias: Bias;
  /** When the current bias was adopted. */
  since: number;
  /** The state this sample is pushing toward, and since when; null when the evidence agrees with the held bias. */
  candidate: { bias: Bias; since: number; needMs: number } | null;
  /** Why the held bias holds (or why it is NEUTRAL). */
  reasons: string[];
}

export interface BiasInput {
  /** False while the book is not live: the bias drops to NEUTRAL at once, with no confirmation delay. */
  valid: boolean;
  /** Direction the entry rules support this sample (stricter); null for none or both. */
  enter: Exclude<Bias, 'NEUTRAL'> | null;
  /** Whether the hold rules (looser) still support each side this sample. */
  holds: { LONG: boolean; SHORT: boolean };
  reasons: string[];
}

/**
 * The micro bias as a persisted state with hysteresis, so it does not flip with every one-second reading:
 *  - entering LONG/SHORT needs the stricter entry rule to hold for `confirmMs`;
 *  - a held bias stays while the looser hold rule is met, and falls back to NEUTRAL only after `releaseMs` without it;
 *  - an opposite entry signal flips it after `confirmMs`;
 *  - invalid data clears it immediately. Integrity never waits for confirmation.
 */
export class MicroBias {
  private state: BiasState;

  constructor(private readonly opts: BiasOptions = DEFAULT_BIAS_OPTIONS, now = 0) {
    this.state = { bias: 'NEUTRAL', since: now, candidate: null, reasons: ['no data yet'] };
  }

  current(): BiasState {
    return { ...this.state, candidate: this.state.candidate ? { ...this.state.candidate } : null, reasons: [...this.state.reasons] };
  }

  update(input: BiasInput, now: number): BiasState {
    const s = this.state;
    // A machine built before any data starts its clock at the first update, so "held" never counts from epoch 0.
    if (s.since === 0) s.since = now;
    if (!input.valid) {
      if (s.bias !== 'NEUTRAL') { s.bias = 'NEUTRAL'; s.since = now; }
      s.candidate = null;
      s.reasons = input.reasons.length ? input.reasons : ['book not live'];
      return this.current();
    }
    let target: Bias;
    if (s.bias === 'NEUTRAL') target = input.enter ?? 'NEUTRAL';
    else if (input.enter && input.enter !== s.bias) target = input.enter;
    else target = input.holds[s.bias] ? s.bias : 'NEUTRAL';

    if (target === s.bias) {
      s.candidate = null;
      s.reasons = input.reasons.length ? input.reasons : s.bias === 'NEUTRAL' ? ['no aligned flow'] : s.reasons;
      return this.current();
    }
    const needMs = target === 'NEUTRAL' ? this.opts.releaseMs : this.opts.confirmMs;
    if (!s.candidate || s.candidate.bias !== target) s.candidate = { bias: target, since: now, needMs };
    if (now - s.candidate.since >= needMs) {
      s.bias = target;
      s.since = now;
      s.candidate = null;
      s.reasons = input.reasons.length ? input.reasons : ['support lapsed'];
    }
    return this.current();
  }
}
