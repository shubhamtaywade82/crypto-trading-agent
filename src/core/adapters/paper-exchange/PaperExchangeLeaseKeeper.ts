import { LeaseRequiredError, type PaperExchangeLease } from '../../../binance/paperExchangeClient.js';
import { AccountLeaseLostError, type AccountLeaseHandle, type AccountLeasePort } from '../../ports/AccountLeasePort.js';

export interface PaperExchangeLeaseKeeperOptions {
  /** The venue's lease port: acquire, renew and release. */
  readonly lease: AccountLeasePort;
  readonly accountId: string;
  /** Shown to operators when another process holds the account. */
  readonly label: string;
  readonly ttlSeconds: number;
  /** Renewal cadence. Defaults to a third of the TTL, so two renewals can fail before the lease lapses. */
  readonly renewEveryMs?: number;
  /** Writes stop this long before the deadline, so a write in flight cannot outlive the lease. Defaults to one second. */
  readonly safetyMarginMs?: number;
  /** Monotonic clock in ms. Deadlines use it, never the wall clock, so stepping the wall clock cannot extend a lease. */
  readonly now?: () => number;
  /** Called once, when the lease is lost. The owner stops writing on it. */
  readonly onLost?: (reason: string) => void;
  readonly log?: (message: string) => void;
}

/** The TTL the agent's writers ask for. A stalled holder loses the lease within this many seconds of its last renewal. */
export const DEFAULT_LEASE_TTL_SECONDS = 30;

type KeeperState = 'idle' | 'held' | 'lost' | 'released';

/**
 * Holds one paper_exchange account lease for this process. It acquires the lease at start, renews it before it can lapse,
 * refuses writes once the lease is lost or past its local deadline, and gives it back on stop.
 *
 * The local deadline is measured from when each request was sent. A slow response shortens the window and never extends it.
 */
export class PaperExchangeLeaseKeeper implements PaperExchangeLease {
  private handle: AccountLeaseHandle | null = null;
  private state: KeeperState = 'idle';
  private deadline = 0;
  private lostReason = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly renewEveryMs: number;
  private readonly safetyMarginMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PaperExchangeLeaseKeeperOptions) {
    if (!(options.ttlSeconds > 0)) throw new Error('the lease TTL must be positive');
    this.renewEveryMs = options.renewEveryMs ?? (options.ttlSeconds * 1000) / 3;
    this.safetyMarginMs = options.safetyMarginMs ?? 1000;
    this.now = options.now ?? (() => performance.now());
  }

  get status(): KeeperState {
    return this.state;
  }

  get fence(): number | null {
    return this.handle?.fence ?? null;
  }

  /** Takes the lease. A lease another process holds throws AccountLeaseHeldError, and startup must treat that as a refusal. */
  async start(): Promise<AccountLeaseHandle> {
    if (this.state === 'held') throw new Error(`the lease for ${this.options.accountId} is already held`);
    const sentAt = this.now();
    const handle = await this.options.lease.acquire(this.options.accountId, this.options.label);
    this.handle = handle;
    this.lostReason = '';
    this.deadline = this.deadlineFrom(sentAt);
    this.state = 'held';
    this.scheduleRenewal();
    return handle;
  }

  /**
   * Extends the lease under its fence. A lease the venue no longer recognises is lost. An unreachable venue is retried until the
   * deadline, and writes stop at the deadline.
   */
  async renew(): Promise<void> {
    if (this.state !== 'held' || this.handle === null) return;
    const sentAt = this.now();
    try {
      const renewed = await this.options.lease.renew(this.handle, this.options.ttlSeconds);
      if (this.state !== 'held') return;
      this.handle = renewed;
      this.deadline = this.deadlineFrom(sentAt);
    } catch (error) {
      if (this.state !== 'held') return;
      if (error instanceof AccountLeaseLostError) {
        this.lose(error.message);
        return;
      }
      this.options.log?.(`[paper-lease] renewing ${this.options.accountId} failed; retrying: ${errorText(error)}`);
    }
    if (this.state === 'held') this.scheduleRenewal();
  }

  /** The headers a write presents. Refuses, and marks the lease lost, once the local deadline has passed without a renewal. */
  writeHeaders(): Readonly<Record<string, string>> {
    if (this.state !== 'held' || this.handle === null) {
      throw new LeaseRequiredError(`no live lease for ${this.options.accountId}${this.lostReason ? `: ${this.lostReason}` : ''}`);
    }
    if (this.now() >= this.deadline) {
      this.lose('the lease ran out before a renewal succeeded');
      throw new LeaseRequiredError(`no live lease for ${this.options.accountId}: ${this.lostReason}`);
    }
    return { 'X-Lease-Holder': this.handle.holderId, 'X-Lease-Fence': String(this.handle.fence) };
  }

  /** The broker refused a write under this lease. Nothing further may be written under it. */
  refused(reason: string): void {
    this.lose(reason);
  }

  /** Stops renewing and gives the lease back. Releasing a lease the broker no longer recognises is not an error. */
  async stop(): Promise<void> {
    this.clearTimer();
    const handle = this.handle;
    this.handle = null;
    this.state = 'released';
    if (handle === null) return;
    await this.options.lease.release(handle).catch((error: unknown) => {
      this.options.log?.(`[paper-lease] releasing ${this.options.accountId} failed: ${errorText(error)}`);
    });
  }

  private lose(reason: string): void {
    if (this.state !== 'held') return;
    this.state = 'lost';
    this.lostReason = reason;
    this.clearTimer();
    this.options.log?.(`[paper-lease] ${this.options.accountId} lost: ${reason}`);
    try {
      this.options.onLost?.(reason);
    } catch (error) {
      this.options.log?.(`[paper-lease] the onLost handler failed: ${errorText(error)}`);
    }
  }

  private deadlineFrom(sentAt: number): number {
    return sentAt + this.options.ttlSeconds * 1000 - this.safetyMarginMs;
  }

  private scheduleRenewal(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.renew();
    }, this.renewEveryMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
