import { parentPort, workerData } from "node:worker_threads";
import { evaluateScript } from "./sandbox-vm";

const { script, input, timeoutMs } = workerData as {
  script: string;
  input: unknown;
  timeoutMs: number;
};
evaluateScript(script, input, timeoutMs).then((outcome) =>
  parentPort?.postMessage(outcome),
);
