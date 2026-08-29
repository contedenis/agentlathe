import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovalBroker } from "./approval-broker";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ask/resolve — the pending-approval lifecycle", () => {
  it("resolves with the client's decision", async () => {
    const broker = createApprovalBroker();
    let requestId = "";
    const decision = broker.ask((id) => {
      requestId = id;
    });

    expect(broker.resolve(requestId, true)).toBe(true);
    await expect(decision).resolves.toBe(true);
  });

  it("each ask gets a distinct request id", () => {
    const broker = createApprovalBroker();
    const ids: string[] = [];
    broker.ask((id) => ids.push(id));
    broker.ask((id) => ids.push(id));

    expect(new Set(ids).size).toBe(2);
  });

  it("times out to a denial and forgets the request", async () => {
    const broker = createApprovalBroker({ timeoutMs: 1000 });
    let requestId = "";
    const decision = broker.ask((id) => {
      requestId = id;
    });

    vi.advanceTimersByTime(1000);

    await expect(decision).resolves.toBe(false);
    expect(broker.resolve(requestId, true)).toBe(false);
  });

  it("resolving an unknown or already-settled request reports false", async () => {
    const broker = createApprovalBroker();
    expect(broker.resolve("ghost", true)).toBe(false);

    let requestId = "";
    const decision = broker.ask((id) => {
      requestId = id;
    });
    broker.resolve(requestId, false);
    await expect(decision).resolves.toBe(false);
    expect(broker.resolve(requestId, true)).toBe(false);
  });
});

describe("session capability tracking", () => {
  it("unknown sessions cannot elicit", () => {
    const broker = createApprovalBroker();
    expect(broker.canElicit("nope")).toBe(false);
  });

  it("remembers what each session negotiated", () => {
    const broker = createApprovalBroker();
    broker.rememberSession("a", true);
    broker.rememberSession("b", false);

    expect(broker.canElicit("a")).toBe(true);
    expect(broker.canElicit("b")).toBe(false);
  });

  it("evicts the least-recently-used session at the cap, never an active one", () => {
    const broker = createApprovalBroker({ maxSessions: 2 });
    broker.rememberSession("old-but-active", true);
    broker.rememberSession("idle", true);

    expect(broker.canElicit("old-but-active")).toBe(true);
    broker.rememberSession("newcomer", true);

    expect(broker.canElicit("old-but-active")).toBe(true);
    expect(broker.canElicit("idle")).toBe(false);
  });

  it("re-negotiating an existing session updates it without evicting others", () => {
    const broker = createApprovalBroker({ maxSessions: 2 });
    broker.rememberSession("a", true);
    broker.rememberSession("b", true);
    broker.rememberSession("a", false);

    expect(broker.canElicit("a")).toBe(false);
    expect(broker.canElicit("b")).toBe(true);
  });
});
