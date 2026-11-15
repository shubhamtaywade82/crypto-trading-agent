/** A lease on one account, held by one process. The fence increases on every acquisition, so a stale holder is recognisable. */
export interface AccountLeaseHandle {
  readonly accountId: string;
  readonly holderId: string;
  readonly fence: number;
  /** Epoch ms, from the venue's clock. */
  readonly expiresAt: number;
}

/** Another process holds the account. Startup must stop: two writers on one account is the failure this lease prevents. */
export class AccountLeaseHeldError extends Error {
  constructor(message: string, readonly holderLabel: string | null, readonly expiresAt: number | null) {
    super(message);
    this.name = 'AccountLeaseHeldError';
  }
}

/** The lease was lost: it expired, or the venue reports another holder. Nothing may be written under it any more. */
export class AccountLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountLeaseLostError';
  }
}

export interface AccountLeasePort {
  acquire(accountId: string, label: string): Promise<AccountLeaseHandle>;
  /** Extends a live lease under its fence. A lease that is no longer live raises AccountLeaseLostError. */
  renew(handle: AccountLeaseHandle, ttlSeconds: number): Promise<AccountLeaseHandle>;
  release(handle: AccountLeaseHandle): Promise<void>;
}
