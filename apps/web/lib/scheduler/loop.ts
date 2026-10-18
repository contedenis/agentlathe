import { closePool, getSettings } from "@agentlathe/db";
import { runRetentionSweep } from "../retention";
import { type Execution, markInterrupted, tick } from "./engine";

const TICK_MS = 30 * 1000;
const TICKS_PER_RETENTION_SWEEP = 20;
const DRAIN_MS = 20 * 1000;
const ABORT_SETTLE_MS = 2 * 1000;

function schedulerEnabled(value = process.env.SCHEDULER_ENABLED) {
  return !["false", "0"].includes((value ?? "").trim().toLowerCase());
}

function settledWithin(promises: Promise<unknown>[], ms: number) {
  return Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

function runLoop() {
  const abort = new AbortController();
  const inFlight = new Map<string, Promise<void>>();
  let ticks = 0;
  let stopping = false;
  let current: Promise<void> | null = null;

  const track = (execution: Execution) => {
    inFlight.set(execution.occurrenceId, execution.done);
    void execution.done.finally(() => inFlight.delete(execution.occurrenceId));
  };

  const runTick = async () => {
    try {
      const sweep = ticks++ % TICKS_PER_RETENTION_SWEEP === 0;
      const [executions] = await Promise.all([
        tick(abort.signal),
        sweep ? getSettings().then(runRetentionSweep) : undefined,
      ]);
      for (const execution of executions) track(execution);
    } catch (err) {
      console.error("scheduler tick failed", err);
    }
  };

  const onInterval = () => {
    if (stopping || current) return;
    current = runTick().finally(() => {
      current = null;
    });
  };
  const timer = setInterval(onInterval, TICK_MS);
  timer.unref();
  onInterval();

  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await current;
      if (await settledWithin([...inFlight.values()], DRAIN_MS)) return;
      abort.abort();
      await settledWithin([...inFlight.values()], ABORT_SETTLE_MS);
      await markInterrupted([...inFlight.keys()]).catch((err) =>
        console.error("marking interrupted runs failed", err),
      );
    },
  };
}

export function startScheduler(): void {
  const state = globalThis as { __agentlatheScheduler?: boolean };
  if (state.__agentlatheScheduler) return;
  state.__agentlatheScheduler = true;

  const loop = schedulerEnabled() ? runLoop() : null;
  if (!process.env.NEXT_MANUAL_SIG_HANDLE) return;
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    try {
      await loop?.stop();
      await closePool();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
