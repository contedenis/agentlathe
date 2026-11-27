import { Worker } from "node:worker_threads";
import type { ScriptOutcome } from "./sandbox-vm";

export const SCRIPT_TIMEOUT_MS = 2_000;
const HOST_GRACE_MS = 1_000;
const MAX_INPUT_CHARS = 256 * 1024;
const MAX_LOG_CHARS = 4_000;
const MAX_LOG_LINES = 200;
const MAX_ERROR_CHARS = 2_000;
const TRUNCATION_SUFFIX = "[truncated]";
export const MAX_CONCURRENT_SCRIPTS = 4;
export const MAX_WAITING_SCRIPTS = 16;

export type ScriptResult = { result: unknown; logs?: string[] };

export class ScriptError extends Error {
  constructor(
    readonly reason: string,
    readonly logs: string[] = [],
  ) {
    super(logs.length > 0 ? `${reason}\nLogs:\n${logs.join("\n")}` : reason);
    this.name = "ScriptError";
  }
}

// The script shares a scope with the VM's own log cap, so the host caps again.
function cappedLogs(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  const kept: string[] = [];
  let remaining = MAX_LOG_CHARS;
  for (const line of logs.slice(0, MAX_LOG_LINES)) {
    if (remaining <= 0) break;
    const text = String(line).slice(0, remaining);
    kept.push(text);
    remaining -= text.length + 1;
  }
  return kept;
}

let running = 0;
const waiting: Array<() => void> = [];

function acquireSlot(abortSignal?: AbortSignal): Promise<void> | undefined {
  if (running < MAX_CONCURRENT_SCRIPTS) {
    running += 1;
    return undefined;
  }
  if (waiting.length >= MAX_WAITING_SCRIPTS)
    throw new ScriptError(
      "The server is running too many scripts right now; try again in a moment.",
    );
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      waiting.splice(waiting.indexOf(start), 1);
      reject(abortSignal?.reason);
    };
    const start = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };
    waiting.push(start);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function spawn(workerData: {
  script: string;
  input: unknown;
  timeoutMs: number;
}): Worker {
  return new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
    workerData,
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
  });
}

type ScriptRun = {
  script: string;
  input: unknown;
  resultLimit: number;
  abortSignal?: AbortSignal;
};

export async function runScript(options: ScriptRun): Promise<ScriptResult> {
  const { input, abortSignal } = options;
  abortSignal?.throwIfAborted();
  if ((JSON.stringify(input) ?? "").length > MAX_INPUT_CHARS)
    throw new ScriptError(
      `The input is larger than ${MAX_INPUT_CHARS} characters.`,
    );

  const queued = acquireSlot(abortSignal);
  if (queued) await queued;
  try {
    return await runInWorker(options);
  } finally {
    releaseSlot();
  }
}

async function runInWorker(options: ScriptRun): Promise<ScriptResult> {
  const { script, input, resultLimit, abortSignal } = options;

  const worker = spawn({ script, input, timeoutMs: SCRIPT_TIMEOUT_MS });
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await new Promise<ScriptOutcome>((resolve, reject) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            error: "The script did not finish in time.",
            logs: [],
          }),
        SCRIPT_TIMEOUT_MS + HOST_GRACE_MS,
      );
      onAbort = () => reject(abortSignal?.reason);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      worker.once("message", resolve);
      worker.once("error", (error) =>
        resolve({
          ok: false,
          error:
            (error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY"
              ? "The script ran out of memory."
              : `The script could not run: ${error.message}`,
          logs: [],
        }),
      );
      worker.once("exit", () =>
        resolve({ ok: false, error: "The script stopped.", logs: [] }),
      );
    });
    if (!outcome || typeof outcome !== "object")
      throw new ScriptError("The script did not return an outcome.");
    const kept = cappedLogs(outcome.logs);
    if (!outcome.ok)
      throw new ScriptError(
        String(outcome.error).slice(0, MAX_ERROR_CHARS),
        kept,
      );
    const logs = kept.length > 0 ? { logs: kept } : {};
    const text = JSON.stringify(outcome.result) ?? "null";
    return text.length > resultLimit
      ? { result: `${text.slice(0, resultLimit)}${TRUNCATION_SUFFIX}`, ...logs }
      : { result: outcome.result, ...logs };
  } finally {
    clearTimeout(timer);
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
    void worker.terminate();
  }
}
