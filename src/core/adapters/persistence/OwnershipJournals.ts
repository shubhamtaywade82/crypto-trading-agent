import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { OwnershipEvent } from '../../domain/ownership.js';
import type { OwnershipJournalPort } from '../../ports/OwnershipJournalPort.js';

/**
 * JSON Lines journal on disk. `append` writes one line, then fsyncs before it returns. The engine submits an entry only after
 * the INTENT line is durable, so a crash can never leave an order on the venue that the journal does not mention.
 *
 * A torn final line (the process died mid-write) was never durable and was never followed by a submission, so it is dropped.
 * Any other unreadable line means the file was damaged, and loading refuses rather than guessing at history.
 */
export class JsonlOwnershipJournal implements OwnershipJournalPort {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(event: OwnershipEvent): void {
    const fd = openSync(this.filePath, 'a');
    try {
      const line = `${JSON.stringify(event)}\n`;
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  load(): OwnershipEvent[] {
    if (!existsSync(this.filePath)) return [];
    const text = readFileSync(this.filePath, 'utf8');
    // Every complete line ends with a newline, so the last element is either '' or the unterminated tail
    const lines = text.split('\n');
    const complete = lines.slice(0, -1);
    const tornTail = text.endsWith('\n') ? null : lines[lines.length - 1];
    const events: OwnershipEvent[] = [];
    complete.forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        events.push(JSON.parse(line) as OwnershipEvent);
      } catch {
        throw new Error(`${this.filePath}: line ${index + 1} is not valid JSON; the ownership journal is damaged and must be inspected`);
      }
    });
    if (tornTail !== null && tornTail.trim() !== '') {
      try {
        events.push(JSON.parse(tornTail) as OwnershipEvent);
      } catch {
        // The last write did not complete; it was never followed by a submission
      }
    }
    return events;
  }
}

/** Keeps events in memory. Research replays use it: their journal is rebuilt on every run. */
export class InMemoryOwnershipJournal implements OwnershipJournalPort {
  private readonly events: OwnershipEvent[] = [];

  append(event: OwnershipEvent): void {
    this.events.push(event);
  }

  load(): readonly OwnershipEvent[] {
    return [...this.events];
  }
}
