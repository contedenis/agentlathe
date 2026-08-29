import { describe, expect, it } from "vitest";
import {
  assembleAgentUsage,
  assembleCapabilities,
  buildChartPoints,
  buildDailySeries,
  type ConfiguredCapability,
  reconcileParents,
  toDate,
} from "./metrics-assembly";

const configured = (
  agentId: string,
  kind: string,
  name: string,
  displayName = name,
): ConfiguredCapability => ({ agentId, kind, name, displayName });

describe("toDate", () => {
  it("parses a valid timestamp and rejects garbage and empties", () => {
    expect(toDate("2026-08-01T00:00:00.000Z")).toEqual(
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(toDate("not a date")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });
});

describe("buildChartPoints — daily series for the charts", () => {
  const days = ["2026-08-14", "2026-08-15"];

  it("latencyPoints use the true per-day percentile, not the max across sources", () => {
    const daily = [
      {
        day: "2026-08-14",
        source: "dashboard",
        runs: 1,
        errors: 0,
        p50DurationMs: 100,
        p95DurationMs: 100,
        inputTokens: 0,
        outputTokens: 0,
      },
      {
        day: "2026-08-14",
        source: "v1",
        runs: 1,
        errors: 0,
        p50DurationMs: 900,
        p95DurationMs: 900,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const dailyLatency = [
      { day: "2026-08-14", p50DurationMs: 400, p95DurationMs: 900 },
    ];

    const { latencyPoints } = buildChartPoints(daily, dailyLatency, days);

    expect(latencyPoints).toEqual([
      { day: "2026-08-14", p50: 400, p95: 900 },
      { day: "2026-08-15", p50: 0, p95: 0 },
    ]);
  });

  it("runPoints still split by source and tokenPoints still sum across sources", () => {
    const daily = [
      {
        day: "2026-08-14",
        source: "dashboard",
        runs: 2,
        errors: 1,
        p50DurationMs: 0,
        p95DurationMs: 0,
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        day: "2026-08-14",
        source: "v1",
        runs: 3,
        errors: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        inputTokens: 20,
        outputTokens: 8,
      },
    ];

    const { runPoints, tokenPoints, sources } = buildChartPoints(
      daily,
      [],
      days,
    );

    expect(sources).toEqual(["dashboard", "v1"]);
    expect(runPoints[0]).toEqual({
      day: "2026-08-14",
      total: 5,
      errors: 1,
      dashboard: 2,
      v1: 3,
    });
    expect(tokenPoints[0]).toEqual({
      day: "2026-08-14",
      input: 30,
      output: 13,
      total: 43,
    });
  });
});

describe("assembleCapabilities — configured vs actually used", () => {
  const stats = (name: string, calls: number, denied = 0) => ({
    kind: "tool",
    name,
    calls,
    errors: 0,
    denied,
    p95DurationMs: 40,
  });

  it("joins configured capabilities with their call stats by derived name", () => {
    const result = assembleCapabilities(
      [configured("a", "tool", "Busqueda_de_cafe", "Búsqueda de café")],
      [stats("Busqueda_de_cafe", 7)],
    );

    expect(result).toEqual([
      {
        kind: "tool",
        name: "Busqueda_de_cafe",
        displayName: "Búsqueda de café",
        configured: true,
        calls: 7,
        errors: 0,
        denied: 0,
        p95DurationMs: 40,
      },
    ]);
  });

  it("configured but never called → zeroed row, still listed", () => {
    const [row] = assembleCapabilities(
      [configured("a", "tool", "unused_tool")],
      [],
    );
    expect(row).toMatchObject({ configured: true, calls: 0, denied: 0 });
  });

  it("called but no longer configured → kept with the derived name as display", () => {
    const [row] = assembleCapabilities([], [stats("ghost_tool", 3)]);
    expect(row).toMatchObject({
      configured: false,
      displayName: "ghost_tool",
      calls: 3,
    });
  });

  it("sorts by activity (calls + denied) with display-name ties", () => {
    const result = assembleCapabilities(
      [
        configured("a", "tool", "quiet"),
        configured("a", "tool", "busy"),
        configured("a", "tool", "denied_a_lot"),
      ],
      [stats("busy", 5), stats("denied_a_lot", 0, 6)],
    );

    expect(result.map((row) => row.name)).toEqual([
      "denied_a_lot",
      "busy",
      "quiet",
    ]);
  });
});

describe("assembleAgentUsage — the overview per-agent table", () => {
  const days = ["2026-08-13", "2026-08-14", "2026-08-15"];

  it("splits configured capabilities into used and unused per agent", () => {
    const { byAgent } = assembleAgentUsage({
      byAgent: [{ agentId: "a", runs: 4 }],
      activeAgents: [{ id: "a", name: "Alpha", model: "m" }],
      configured: [
        configured("a", "tool", "used_one"),
        configured("a", "tool", "never_used", "Never used"),
      ],
      used: [{ agentId: "a", kind: "tool", name: "used_one" }],
      perAgentDaily: [],
      days,
    });

    expect(byAgent[0].configured).toBe(2);
    expect(byAgent[0].unused).toEqual([
      { kind: "tool", name: "never_used", displayName: "Never used" },
    ]);
  });

  it("builds the sparkline series and splits previous-window runs", () => {
    const { byAgent } = assembleAgentUsage({
      byAgent: [{ agentId: "a", runs: 5 }],
      activeAgents: [],
      configured: [],
      used: [],
      perAgentDaily: [
        { agentId: "a", day: "2026-08-10", runs: 9 },
        { agentId: "a", day: "2026-08-14", runs: 3 },
        { agentId: "a", day: "2026-08-15", runs: 2 },
      ],
      days,
    });

    expect(byAgent[0].series).toEqual([0, 3, 2]);
    expect(byAgent[0].activeDays).toBe(2);
    expect(byAgent[0].previousRuns).toBe(9);
    expect(byAgent[0].recentRuns).toBe(5);
  });

  it("active agents with no runs in the window land in neverRun", () => {
    const { neverRun } = assembleAgentUsage({
      byAgent: [{ agentId: "a", runs: 1 }],
      activeAgents: [
        { id: "a", name: "Alpha", model: "m" },
        { id: "b", name: "Beta", model: "m" },
      ],
      configured: [],
      used: [],
      perAgentDaily: [],
      days,
    });

    expect(neverRun).toEqual([{ id: "b", name: "Beta", model: "m" }]);
  });
});

describe("buildDailySeries — window series and trend input", () => {
  it("maps runs onto the window and sums everything before it", () => {
    const { series, previousRuns, activeDays } = buildDailySeries(
      [
        { day: "2026-08-01", runs: 10 },
        { day: "2026-08-14", runs: 2 },
      ],
      ["2026-08-14", "2026-08-15"],
    );

    expect(series).toEqual([2, 0]);
    expect(previousRuns).toBe(10);
    expect(activeDays).toBe(1);
  });
});

describe("reconcileParents — who delegates to this agent", () => {
  it("keeps linked parents with zero calls and surfaces unlinked callers", () => {
    const parents = reconcileParents(
      [
        { id: "p1", name: "Linked quiet" },
        { id: "p2", name: "Linked busy" },
      ],
      [
        { parentId: "p2", parentName: "Linked busy", calls: 8 },
        { parentId: "p3", parentName: "Unlinked caller", calls: 5 },
      ],
    );

    expect(parents).toEqual([
      { id: "p2", name: "Linked busy", calls: 8 },
      { id: "p3", name: "Unlinked caller", calls: 5 },
      { id: "p1", name: "Linked quiet", calls: 0 },
    ]);
  });
});
