import { afterEach, describe, expect, it, vi } from "vitest";

type FakeWorker = {
  terminate: ReturnType<typeof vi.fn>;
  emit: (event: string, value: unknown) => boolean;
};

const workers = vi.hoisted(() => [] as FakeWorker[]);

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(
      _url: URL,
      options: {
        workerData: { script: string; input: unknown; timeoutMs: number };
      },
    ) {
      super();
      workers.push(this);
      const { script, input, timeoutMs } = options.workerData;
      if (script === "HANG") return;
      void import("./sandbox-vm").then(async ({ evaluateScript }) =>
        this.emit("message", await evaluateScript(script, input, timeoutMs)),
      );
    }
  }
  return { Worker };
});

import { runScript, ScriptError } from "./sandbox";

afterEach(() => {
  workers.length = 0;
  vi.useRealTimers();
});

describe("runScript", () => {
  it("returns the script's value, and its logs only when there are any", async () => {
    await expect(
      runScript({
        script: "return input.n + 1;",
        input: { n: 1 },
        resultLimit: 100,
      }),
    ).resolves.toEqual({ result: 2 });
    await expect(
      runScript({
        script: "console.log('hi'); return 1;",
        input: null,
        resultLimit: 100,
      }),
    ).resolves.toEqual({ result: 1, logs: ["hi"] });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("throws a real Error carrying the script's error and its logs", async () => {
    const failure = runScript({
      script: "console.log('step 1'); throw new Error('bad date');",
      input: null,
      resultLimit: 100,
    });

    await expect(failure).rejects.toBeInstanceOf(ScriptError);
    await expect(failure).rejects.toThrow("Error: bad date\nLogs:\nstep 1");
  });

  it("cuts a result over the limit and marks it", async () => {
    const { result } = await runScript({
      script: "return 'x'.repeat(500);",
      input: null,
      resultLimit: 100,
    });

    expect(result).toBe(`"${"x".repeat(99)}[truncated]`);
  });

  it("terminates a worker that never answers", async () => {
    vi.useFakeTimers();
    const failure = runScript({
      script: "HANG",
      input: null,
      resultLimit: 100,
    });
    const assertion = expect(failure).rejects.toThrow(
      "The script did not finish in time.",
    );

    await vi.advanceTimersByTimeAsync(3_000);

    await assertion;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("stops with the run when it is cancelled, without calling it a script failure", async () => {
    const abort = new AbortController();
    const failure = runScript({
      script: "HANG",
      input: null,
      resultLimit: 100,
      abortSignal: abort.signal,
    });
    const reason = new Error("run cancelled");

    abort.abort(reason);

    await expect(failure).rejects.toBe(reason);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("refuses an input too large to hand over, without starting a worker", async () => {
    await expect(
      runScript({
        script: "return 1;",
        input: "x".repeat(300 * 1024),
        resultLimit: 100,
      }),
    ).rejects.toThrow("The input is larger than");
    expect(workers).toHaveLength(0);
  });

  it("caps the logs and the error again on the host, whatever the script did to the VM's own cap", async () => {
    const flooded = await runScript({
      script:
        "__logs.push('L'.repeat(100000)); for (let i = 0; i < 5000; i++) __logs.push(''); return 1;",
      input: null,
      resultLimit: 100,
    });
    expect(flooded.logs?.length).toBeLessThanOrEqual(200);
    expect((flooded.logs ?? []).join("\n").length).toBeLessThanOrEqual(4200);

    const failure = runScript({
      script: "throw new Error('E'.repeat(100000));",
      input: null,
      resultLimit: 100,
    });
    await expect(failure).rejects.toThrow(/^Error: E{1990,1993}$/);
  });

  it("does not trust the shape of what the worker posts", async () => {
    const failure = runScript({
      script: "HANG",
      input: null,
      resultLimit: 100,
    });
    workers[0].emit("message", 5);

    await expect(failure).rejects.toThrow("did not return an outcome");
  });

  it("runs four scripts at a time, queues the next sixteen and refuses the rest", async () => {
    const hang = () =>
      runScript({ script: "HANG", input: null, resultLimit: 100 });
    const answers = Array.from({ length: 20 }, hang).map((run) =>
      run.catch((error: Error) => error.message),
    );
    await vi.waitFor(() => expect(workers).toHaveLength(4));

    await expect(hang()).rejects.toThrow("too many scripts right now");
    expect(workers).toHaveLength(4);

    workers[0].emit("message", { ok: true, result: 1, logs: [] });
    await vi.waitFor(() => expect(workers).toHaveLength(5));

    for (let next = 1; next < 20; next += 1) {
      await vi.waitFor(() => expect(workers.length).toBeGreaterThan(next));
      workers[next].emit("message", { ok: true, result: 1, logs: [] });
    }
    expect(await Promise.all(answers)).toHaveLength(20);
    expect(workers).toHaveLength(20);
  });

  it("gives up its place in the queue when its run is cancelled, and frees its slot when it ends", async () => {
    const running = Array.from({ length: 4 }, () =>
      runScript({ script: "HANG", input: null, resultLimit: 100 }),
    );
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    const abort = new AbortController();
    const queued = runScript({
      script: "HANG",
      input: null,
      resultLimit: 100,
      abortSignal: abort.signal,
    });
    const reason = new Error("run cancelled");

    abort.abort(reason);

    await expect(queued).rejects.toBe(reason);
    for (const worker of workers)
      worker.emit("message", { ok: true, result: 1, logs: [] });
    await Promise.all(running);
    expect(workers).toHaveLength(4);
    await expect(
      runScript({ script: "return 2;", input: null, resultLimit: 100 }),
    ).resolves.toEqual({ result: 2 });
  });

  it("reports a worker that dies", async () => {
    const failure = runScript({
      script: "HANG",
      input: null,
      resultLimit: 100,
    });
    workers[0].emit(
      "error",
      Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }),
    );

    await expect(failure).rejects.toThrow("The script ran out of memory.");
  });
});
