import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TradingEvent } from '../../events/TradingEvent.js';
import type { ResearchRepository } from '../../ports/ResearchRepository.js';

/**
 * Append-only JSON Lines journal: one event per line, written synchronously in publish order, never rewritten.
 * Reading it back yields the engine's event stream exactly as it happened.
 */
export class JsonlResearchRepository implements ResearchRepository {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(event: TradingEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
  }

  /** A torn final line (the process died mid-write) is dropped; any other unreadable line is an error. */
  read(): TradingEvent[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    // A complete file ends with a newline, leaving an empty last element; otherwise the last element is the torn line
    const complete = lines.slice(0, -1);
    return complete.filter((line) => line.trim() !== '').map((line, i) => {
      try {
        return JSON.parse(line) as TradingEvent;
      } catch {
        throw new Error(`${this.filePath}: line ${i + 1} is not valid JSON`);
      }
    });
  }
}

/** Keeps events in memory. Used by research runs, which report from the collected stream. */
export class InMemoryResearchRepository implements ResearchRepository {
  readonly events: TradingEvent[] = [];

  append(event: TradingEvent): void {
    this.events.push(event);
  }
}
