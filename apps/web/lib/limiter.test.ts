import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter";

function deferred() {
  let resolve: () => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLimiter", () => {
  it("never runs more than max tasks at once and drains the queue", async () => {
    const limit = createLimiter(3);
    const gates = Array.from({ length: 10 }, deferred);
    let running = 0;
    let peak = 0;
    const done = gates.map((gate) =>
      limit(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await flush();
    expect(running).toBe(3);
    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    await Promise.all(done);

    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it("a rejected task reaches its caller and frees its slot", async () => {
    const limit = createLimiter(1);
    const failing = limit(() => Promise.reject(new Error("boom")));
    const after = limit(async () => "ran");

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ran");
  });

  it("a task that throws synchronously is a rejection, not a stall", async () => {
    const limit = createLimiter(1);
    const throwing = limit(() => {
      throw new Error("sync");
    });

    await expect(throwing).rejects.toThrow("sync");
    await expect(limit(async () => 1)).resolves.toBe(1);
  });
});
