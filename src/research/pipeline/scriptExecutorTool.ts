/**
 * Sandboxed script execution tool for autonomous quant research sessions.
 * Allows the LLM to write and execute exploratory TypeScript scripts in a dedicated scratchpad.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRATCH_DIR = path.resolve('data/research/scratch');
const TIMEOUT_MS = 25_000;
const MAX_OUTPUT_CHARS = 4_000;

mkdirSync(SCRATCH_DIR, { recursive: true });

export interface ScriptExecutionResult {
  success: boolean;
  output: string;
  executionTimeMs: number;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
}

export async function executeResearchScript(code: string): Promise<ScriptExecutionResult> {
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 8);
  const scriptPath = path.join(SCRATCH_DIR, `agent_${Date.now()}_${hash}.ts`);
  const startedAt = Date.now();

  try {
    writeFileSync(scriptPath, code, 'utf8');
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', scriptPath], {
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
    });
    const output = truncateOutput((stdout || stderr || '(no output)').trim());
    return { success: true, output, executionTimeMs: Date.now() - startedAt };
  } catch (error: any) {
    const errorText = error.stderr || error.stdout || error.message || String(error);
    return { success: false, output: truncateOutput(errorText.trim()), executionTimeMs: Date.now() - startedAt };
  } finally {
    try { rmSync(scriptPath, { force: true }); } catch { /* ignore */ }
  }
}
