import { randomUUID } from 'node:crypto';
import { AccountLeaseHeldError, type AccountLeaseHandle, type AccountLeasePort } from '../../ports/AccountLeasePort.js';

export interface PaperExchangeLeaseOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly ttlSeconds: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface LeaseReply {
  readonly holder_id: string;
  readonly holder_label?: string | null;
  readonly fence: number;
  readonly expires_at: string;
}

/**
 * Acquires and releases the paper_exchange lease for one account. The server decides who holds it; this adapter only asks.
 * A held lease surfaces as AccountLeaseHeldError, carrying the holder's label and expiry, so startup can say what is blocking.
 *
 * Heartbeats, the local watchdog and per-request fencing belong to the Agent runtime; they are not part of this port.
 */
export class PaperExchangeLeaseAdapter implements AccountLeasePort {
  private readonly fetchImpl: typeof fetch;
  /**
   * One holder per adapter. A retried acquire renews this holder's live lease at the same fence, instead of leaving a
   * ghost holder that blocks the account until its TTL runs out.
   */
  private readonly holderId = randomUUID();

  constructor(private readonly options: PaperExchangeLeaseOptions) {
    if (!(options.ttlSeconds > 0)) throw new Error('the lease TTL must be positive');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async acquire(accountId: string, label: string): Promise<AccountLeaseHandle> {
    const { status, body, text } = await this.send('POST', accountId, {
      holder_id: this.holderId, holder_label: label, ttl_seconds: this.options.ttlSeconds,
    });
    if (status === 409 && body?.error === 'lease_held') {
      const holder = typeof body.holder_label === 'string' ? body.holder_label : null;
      const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : null;
      throw new AccountLeaseHeldError(
        `account ${accountId} is leased by ${holder ?? 'another process'}${expiresAt ? ` until ${new Date(expiresAt).toISOString()}` : ''}`,
        holder,
        expiresAt,
      );
    }
    if (status < 200 || status >= 300 || !body) throw new Error(`paper_exchange lease acquire for ${accountId} failed: ${status} ${text}`);
    const reply = body as unknown as LeaseReply;
    return { accountId, holderId: String(reply.holder_id), fence: Number(reply.fence), expiresAt: Date.parse(reply.expires_at) };
  }

  async release(handle: AccountLeaseHandle): Promise<void> {
    const { status, text } = await this.send('DELETE', handle.accountId, undefined, {
      'X-Lease-Holder': handle.holderId,
      'X-Lease-Fence': String(handle.fence),
    });
    // A lease that already expired or was released is released; only a server failure is an error
    if (status >= 500) throw new Error(`paper_exchange lease release for ${handle.accountId} failed: ${status} ${text}`);
  }

  private async send(
    method: 'POST' | 'DELETE',
    accountId: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Account-Id': accountId, ...extraHeaders };
    if (this.options.apiKey) headers['X-API-Key'] = this.options.apiKey;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}/api/account/lease`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw new Error(`paper_exchange lease ${method} for ${accountId} is unreachable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, text };
  }
}
