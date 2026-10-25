export type OptionTradeState = 'IDLE' | 'SIGNAL_DETECTED' | 'ENTRY_PENDING' | 'POSITION_OPEN' | 'EXIT_PENDING' | 'POSITION_CLOSED';

export type OptionTradeEvent =
  | 'SIGNAL'        // IDLE -> SIGNAL_DETECTED: a direction was read
  | 'REJECT'        // SIGNAL_DETECTED -> IDLE: selection, economics, risk or the LLM refused it
  | 'SUBMIT'        // SIGNAL_DETECTED -> ENTRY_PENDING: an order id is persisted, then sent
  | 'FILL'          // ENTRY_PENDING -> POSITION_OPEN: some quantity filled
  | 'NO_FILL'       // ENTRY_PENDING -> IDLE: venue rejected, or nothing filled
  | 'EXIT_TRIGGER'  // POSITION_OPEN -> EXIT_PENDING
  | 'PARTIAL_EXIT'  // EXIT_PENDING -> EXIT_PENDING: part closed, the rest is retried
  | 'EXIT_RETRY'    // EXIT_PENDING -> EXIT_PENDING: the close failed and is retried
  | 'EXIT_FILL'     // EXIT_PENDING -> POSITION_CLOSED: flat
  | 'EXTERNAL_CLOSE'// POSITION_OPEN | EXIT_PENDING -> POSITION_CLOSED: the venue shows no position
  | 'ADOPT'         // IDLE -> POSITION_OPEN: startup reconciliation found an untracked venue position
  | 'RESET';        // POSITION_CLOSED -> IDLE: cooldown elapsed

const TRANSITIONS: Readonly<Record<OptionTradeState, Partial<Record<OptionTradeEvent, OptionTradeState>>>> = {
  IDLE: { SIGNAL: 'SIGNAL_DETECTED', ADOPT: 'POSITION_OPEN' },
  SIGNAL_DETECTED: { REJECT: 'IDLE', SUBMIT: 'ENTRY_PENDING' },
  ENTRY_PENDING: { FILL: 'POSITION_OPEN', NO_FILL: 'IDLE' },
  POSITION_OPEN: { EXIT_TRIGGER: 'EXIT_PENDING', EXTERNAL_CLOSE: 'POSITION_CLOSED' },
  EXIT_PENDING: { PARTIAL_EXIT: 'EXIT_PENDING', EXIT_RETRY: 'EXIT_PENDING', EXIT_FILL: 'POSITION_CLOSED', EXTERNAL_CLOSE: 'POSITION_CLOSED' },
  POSITION_CLOSED: { RESET: 'IDLE' },
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: OptionTradeState, readonly event: OptionTradeEvent) {
    super(`illegal option trade transition: ${event} from ${from}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Next state for (state, event), or throws: every pair not in the table is a bug, never a silent no-op. */
export function transition(from: OptionTradeState, event: OptionTradeEvent): OptionTradeState {
  const next = TRANSITIONS[from][event];
  if (!next) throw new IllegalTransitionError(from, event);
  return next;
}

export const canTransition = (from: OptionTradeState, event: OptionTradeEvent): boolean => TRANSITIONS[from][event] !== undefined;
