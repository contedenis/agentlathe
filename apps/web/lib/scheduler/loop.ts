import { closePool, getSettings } from "@agentlathe/db";
import { processKnowledge, stopKnowledgeProcessing } from "../knowledge/engine";
import { runRetentionSweep } from "../retention";
import { stopRuns, tick } from "./engine";

const TICK_MS = 30 * 1000;
const TICKS_PER_RETENTION_SWEEP = 20;
const DRAIN_MS = 20 * 1000;
const ABORT_SETTLE_MS = 2 * 1000;

function schedulerEnabled(value = process.env.SCHEDULER_ENABLED) {
  return !["false", "0"].includes((value ?? "").trim().toLowerCase());
}

function runLoop() {
  let ticks = 0;
  let stopping = false;
  let current: Promise<void> | null = null;

  const runTick = async () => {
    void processKnowledge().catch((err) =>
      console.error("knowledge processing failed", err),
    );
    try {
      const sweep = ticks++ % TICKS_PER_RETENTION_SWEEP === 0;
      await Promise.all([
        tick(),
        sweep ? getSettings().then(runRetentionSweep) : undefined,
      ]);
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
      await Promise.all([
        current,
        stopKnowledgeProcessing().catch((err) =>
          console.error("stopping knowledge processing failed", err),
        ),
      ]);
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
      await stopRuns(DRAIN_MS, ABORT_SETTLE_MS);
      await closePool();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
