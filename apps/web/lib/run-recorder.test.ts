import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("./evaluations", () => ({
  evaluateRun: vi.fn(),
  hasActiveCriteria: vi.fn(),
}));

import { after } from "next/server";
import { evaluateRun, hasActiveCriteria } from "./evaluations";
import { scheduleRunEvaluation } from "./run-recorder";

const agent = { id: "agent-1", autoEvaluate: true };
const scheduled = () =>
  vi.mocked(after).mock.calls.map(([task]) => task as Promise<unknown>);

describe("scheduleRunEvaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(after).mockImplementation(() => {});
    vi.mocked(hasActiveCriteria).mockResolvedValue(true);
    vi.mocked(evaluateRun).mockResolvedValue({ evaluations: [] });
  });

  it("never touches the database for an agent with auto_evaluate off", () => {
    scheduleRunEvaluation("run-1", { ...agent, autoEvaluate: false });

    expect(after).not.toHaveBeenCalled();
    expect(hasActiveCriteria).not.toHaveBeenCalled();
    expect(evaluateRun).not.toHaveBeenCalled();
  });

  it("hands the evaluation to after() and returns before it runs", async () => {
    scheduleRunEvaluation("run-1", agent);

    expect(hasActiveCriteria).not.toHaveBeenCalled();
    expect(evaluateRun).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(expect.any(Promise));
    await Promise.all(scheduled());
    expect(hasActiveCriteria).toHaveBeenCalledWith("agent-1");
    expect(evaluateRun).toHaveBeenCalledWith("run-1");
  });

  it("an agent without active criteria never loads the run", async () => {
    vi.mocked(hasActiveCriteria).mockResolvedValue(false);

    scheduleRunEvaluation("run-1", agent);
    await Promise.all(scheduled());

    expect(evaluateRun).not.toHaveBeenCalled();
  });

  it("still evaluates when after() has no request scope", async () => {
    vi.mocked(after).mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    expect(() => scheduleRunEvaluation("run-1", agent)).not.toThrow();
    await vi.waitFor(() => expect(evaluateRun).toHaveBeenCalledWith("run-1"));
  });

  it("swallows and logs a rejected evaluation", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(evaluateRun).mockRejectedValue(new Error("db down"));

    scheduleRunEvaluation("run-1", agent);

    await expect(scheduled()[0]).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "automatic evaluation failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("runs at most 3 evaluations at once, and a failing one does not block the rest", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    vi.mocked(evaluateRun).mockImplementation(async (runId) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      if (runId === "run-0") throw new Error("judge down");
      return { evaluations: [] };
    });

    for (let index = 0; index < 10; index++)
      scheduleRunEvaluation(`run-${index}`, agent);

    await vi.waitFor(() => expect(running).toBe(3));
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(scheduled());

    expect(peak).toBe(3);
    expect(evaluateRun).toHaveBeenCalledTimes(10);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
