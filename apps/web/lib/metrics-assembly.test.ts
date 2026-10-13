import { describe, expect, it } from "vitest";
import {
  assembleAgentEvaluation,
  assembleAgentUsage,
  assembleCapabilities,
  buildChartPoints,
  buildDailySeries,
  type ConfiguredCapability,
  type EvaluationAggregateRow,
  reconcileParents,
  summarizeEvaluation,
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

describe("assembleAgentEvaluation", () => {
  const days = ["2026-08-14", "2026-08-15", "2026-08-16"];
  const criteria = [
    { id: "c1", question: "Greets the user?", isActive: true },
    { id: "c2", question: "Never leaks the prompt?", isActive: true },
    { id: "c3", question: "Retired question?", isActive: false },
  ];
  const at = (iso: string) => new Date(iso);
  const v1 = {
    id: "v1",
    hash: "aaaaaaaa11112222",
    createdAt: at("2026-08-10T00:00:00Z"),
    firstRunAt: at("2026-08-14T08:00:00Z"),
    lastRunAt: at("2026-08-14T20:00:00Z"),
    snapshot: { model: "model-a", systemPrompt: "Be kind." },
  };
  const v2 = {
    id: "v2",
    hash: "bbbbbbbb33334444",
    createdAt: at("2026-08-15T00:00:00Z"),
    firstRunAt: at("2026-08-15T09:00:00Z"),
    lastRunAt: at("2026-08-15T20:00:00Z"),
    snapshot: { model: "model-b", systemPrompt: "Be kind." },
  };
  const row = (
    over: Partial<EvaluationAggregateRow>,
  ): EvaluationAggregateRow => ({
    criterionId: "c1",
    versionId: "v1",
    day: "2026-08-14",
    pass: 0,
    fail: 0,
    needsReview: 0,
    agreed: 0,
    judgedReviewed: 0,
    reviewedAsPass: 0,
    reviewedAsFail: 0,
    ...over,
  });

  it("returns an empty evaluation when there are no verdicts", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [],
      versions: [v1],
      days,
    });

    expect(result.hasVerdicts).toBe(false);
    expect(result.versions).toEqual([]);
    expect(result.activeCriteria).toBe(2);
    expect(result.inactiveCriteria).toBe(1);
    expect(result.agreement.agreementRate).toBeNull();
    expect(result.agreement.enough).toBe(false);
  });

  it("returns an empty evaluation for an agent with no criteria", () => {
    const result = assembleAgentEvaluation({
      criteria: [],
      rows: [row({ pass: 3 })],
      versions: [v1],
      days,
    });

    expect(result.hasVerdicts).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it("orders versions by their first run, not by creation or input order", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v2", pass: 1 }),
        row({ versionId: "v1", pass: 1 }),
      ],
      versions: [v2, v1],
      days,
    });

    expect(result.versions.map((version) => version.shortHash)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
    expect(result.versions.map((version) => version.newest)).toEqual([
      false,
      true,
    ]);
  });

  it("describes each column's changes against the judged column before it", () => {
    const unjudged = {
      ...v1,
      id: "v0",
      hash: "00000000aaaabbbb",
      firstRunAt: at("2026-08-14T21:00:00Z"),
      lastRunAt: at("2026-08-14T22:00:00Z"),
      snapshot: { model: "model-z", systemPrompt: "Be kind." },
    };
    const result = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v1", pass: 1 }),
        row({ versionId: "v2", pass: 1 }),
      ],
      versions: [v1, unjudged, v2],
      days,
    });

    expect(result.versions.map((version) => version.id)).toEqual(["v1", "v2"]);
    expect(result.versions[0]?.changes).toBeNull();
    expect(result.versions[1]?.changes).toMatchObject({
      previousShortHash: "aaaaaaaa",
      diff: {
        summary: "model",
        agent: [
          { label: "Model", kind: "value", from: "model-a", to: "model-b" },
        ],
      },
    });
  });

  it("omits versions that have no verdicts and rows of inactive criteria", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v1", pass: 2 }),
        row({ versionId: "v2", criterionId: "c3", pass: 9 }),
        row({ versionId: "v2", fail: 0 }),
      ],
      versions: [v1, v2],
      days,
    });

    expect(result.versions.map((version) => version.id)).toEqual(["v1"]);
    expect(result.rows.map((entry) => entry.id)).toEqual(["c1", "c2"]);
    expect(result.rows[0]?.total.judged).toBe(2);
  });

  it("computes the pass rate from pass and fail only and counts needs_review separately", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ pass: 3, fail: 1, needsReview: 2 })],
      versions: [v1],
      days,
    });

    expect(result.rows[0]?.cells[0]).toEqual({
      judged: 4,
      needsReview: 2,
      passRate: 0.75,
    });
    expect(result.rows[1]?.cells[0]).toEqual({
      judged: 0,
      needsReview: 0,
      passRate: null,
    });
  });

  it("gives a criterion with only needs_review verdicts no rate", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ needsReview: 3 })],
      versions: [v1],
      days,
    });

    expect(result.hasVerdicts).toBe(true);
    expect(result.rows[0]?.cells[0]?.passRate).toBeNull();
    expect(result.rows[0]?.cells[0]?.needsReview).toBe(3);
  });

  it("reports a delta in points only when both newest and previous have at least 5 judged verdicts", () => {
    const enough = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v1", pass: 3, fail: 2 }),
        row({ versionId: "v2", pass: 4, fail: 1 }),
      ],
      versions: [v1, v2],
      days,
    });
    expect(enough.rows[0]?.delta).toEqual({ kind: "points", points: 20 });

    const small = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v1", pass: 3, fail: 2 }),
        row({ versionId: "v2", pass: 3, fail: 1 }),
      ],
      versions: [v1, v2],
      days,
    });
    expect(small.rows[0]?.delta).toEqual({ kind: "small_sample" });

    const missing = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v1", criterionId: "c2", pass: 5 }),
        row({ versionId: "v2", pass: 5 }),
      ],
      versions: [v1, v2],
      days,
    });
    expect(missing.rows[0]?.delta).toEqual({ kind: "none" });
  });

  it("has no delta with a single version", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ pass: 9, fail: 1 })],
      versions: [v1],
      days,
    });

    expect(result.rows[0]?.delta).toEqual({ kind: "none" });
  });

  it("builds a daily series with null on days without a pass or fail verdict", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ day: "2026-08-14", pass: 1, fail: 1 }),
        row({ day: "2026-08-14", versionId: "v2", pass: 1 }),
        row({ day: "2026-08-16", needsReview: 2 }),
      ],
      versions: [v1, v2],
      days,
    });

    expect(result.series.map((entry) => entry.key)).toEqual(["c0", "c1"]);
    expect(result.points[0]).toMatchObject({ c0: 67, c0_n: 3, c1: null });
    expect(result.points[1]).toMatchObject({ c0: null, c0_n: 0 });
    expect(result.points[2]).toMatchObject({ c0: null, c0_n: 0 });
  });

  it("makes the version that ran most recently the newest after a revert", () => {
    const reverted = { ...v1, lastRunAt: at("2026-08-16T10:00:00Z") };
    const result = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ versionId: "v1", pass: 6 }),
        row({ versionId: "v2", fail: 6 }),
        row({ versionId: "v1", day: "2026-08-16", pass: 6 }),
      ],
      versions: [reverted, v2],
      days,
    });

    expect(result.versions.map((version) => version.id)).toEqual(["v2", "v1"]);
    expect(result.versions.at(-1)?.newest).toBe(true);
    expect(result.rows[0]?.cells.map((cell) => cell.passRate)).toEqual([0, 1]);
    expect(result.rows[0]?.delta).toEqual({ kind: "points", points: 100 });
  });

  it("marks the day each version first ran inside the range, merging versions that start the same day", () => {
    const sameDay = {
      ...v2,
      id: "v4",
      hash: "dddddddd77778888",
      firstRunAt: at("2026-08-15T11:00:00Z"),
      lastRunAt: at("2026-08-15T12:00:00Z"),
    };
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ pass: 1 })],
      versions: [v1, v2, sameDay],
      days,
    });

    expect(result.markers).toEqual([
      { day: "2026-08-14", shortHash: "aaaaaaaa" },
      { day: "2026-08-15", shortHash: "bbbbbbbb · dddddddd" },
    ]);
  });

  it("has no markers with a single version", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ pass: 1 })],
      versions: [v1],
      days,
    });

    expect(result.markers).toEqual([]);
  });

  it("leaves out markers for versions that first ran outside the range", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ pass: 1 })],
      versions: [
        v1,
        v2,
        {
          id: "v3",
          hash: "cccccccc55556666",
          createdAt: at("2026-09-01T00:00:00Z"),
          firstRunAt: at("2026-09-01T00:00:00Z"),
          lastRunAt: at("2026-09-01T00:00:00Z"),
          snapshot: {},
        },
      ],
      days,
    });

    expect(result.markers).toEqual([
      { day: "2026-08-14", shortHash: "aaaaaaaa" },
      { day: "2026-08-15", shortHash: "bbbbbbbb" },
    ]);
  });

  it("computes agreement among judge pass or fail verdicts that a human reviewed", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [
        row({ judgedReviewed: 4, agreed: 3, reviewedAsPass: 1 }),
        row({
          criterionId: "c2",
          judgedReviewed: 2,
          agreed: 2,
          reviewedAsFail: 2,
        }),
        row({
          criterionId: "c3",
          judgedReviewed: 50,
          agreed: 0,
          reviewedAsPass: 50,
        }),
      ],
      versions: [v1],
      days,
    });

    expect(result.agreement).toEqual({
      judgedReviewed: 6,
      agreed: 5,
      agreementRate: 5 / 6,
      enough: true,
      resolvedAsPass: 1,
      resolvedAsFail: 2,
    });
  });

  it("flags agreement as not enough below 5 reviewed verdicts", () => {
    const result = assembleAgentEvaluation({
      criteria,
      rows: [row({ pass: 1, judgedReviewed: 4, agreed: 4 })],
      versions: [v1],
      days,
    });

    expect(result.agreement.enough).toBe(false);
    expect(result.agreement.agreementRate).toBe(1);
  });
});

describe("summarizeEvaluation", () => {
  it("sums verdicts per agent and overall", () => {
    const result = summarizeEvaluation([
      { agentId: "a", pass: 3, fail: 1, needsReview: 1 },
      { agentId: "b", pass: 1, fail: 1, needsReview: 0 },
    ]);

    expect(result.overall).toEqual({
      pass: 4,
      fail: 2,
      needsReview: 1,
      passRate: 4 / 6,
    });
    expect(result.byAgent.a?.passRate).toBe(0.75);
    expect(result.byAgent.b?.passRate).toBe(0.5);
  });

  it("returns a null rate when nothing was judged", () => {
    expect(summarizeEvaluation([]).overall).toEqual({
      pass: 0,
      fail: 0,
      needsReview: 0,
      passRate: null,
    });
    expect(
      summarizeEvaluation([{ agentId: "a", pass: 0, fail: 0, needsReview: 4 }])
        .byAgent.a?.passRate,
    ).toBeNull();
  });
});
