import { BinanceClient } from '@nemesis-oss/binance-sdk';
import type { StreamHandle } from '../microstructure/MicrostructureFeed.js';

interface SubEntry {
  handle: StreamHandle;
  refCount: number;
}

/**
 * Process-wide registry for USD-M WebSocket streams to prevent duplicate connections
 * across the orchestrator, fleet supervisor, and market data feeds.
 */
export class UsdmStreamRegistry {
  private readonly subs = new Map<string, Promise<SubEntry>>();
  private readonly client: BinanceClient;
  private closed = false;

  constructor(client?: BinanceClient) {
    this.client = client ?? new BinanceClient({ safety: { readOnly: true } });
  }

  async acquire(stream: string): Promise<{ handle: StreamHandle; release: () => void }> {
    if (this.closed) throw new Error('UsdmStreamRegistry closed');
    let promise = this.subs.get(stream);
    if (!promise) {
      promise = (async () => {
        const handle = await this.client.ws.usdm.subscribe(stream) as unknown as StreamHandle;
        return { handle, refCount: 0 };
      })();
      this.subs.set(stream, promise);
    }

    const entry = await promise;
    entry.refCount += 1;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount <= 0) {
        this.subs.delete(stream);
        try { entry.handle.close(); } catch { /* ignore */ }
      }
    };

    return { handle: entry.handle, release };
  }

  activeStreamCount(): number {
    return this.subs.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [stream, promise] of this.subs) {
      try {
        const entry = await promise;
        entry.handle.close();
      } catch { /* ignore */ }
    }
    this.subs.clear();
  }
}

export const sharedStreamRegistry = new UsdmStreamRegistry();
