import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, buildProvider: vi.fn() };
});

import {
  CompactionError,
  checkCompaction,
  compactionPrompt,
  planCompaction,
} from "./compaction";
import { buildProvider } from "./helpers";

const day = new Date("2026-10-10T00:00:00Z");
const entries = [
  {
    shortId: "a1",
    content: "Refunds over $500 go to billing.",
    pinned: false,
    updatedAt: day,
  },
  {
    shortId: "a2",
    content: "Refunds above $500 are for billing.",
    pinned: false,
    updatedAt: day,
  },
  {
    shortId: "a3",
    content: "Never call the legacy API.",
    pinned: true,
    updatedAt: day,
  },
  {
    shortId: "a4",
    content: "The office moved in 2019.",
    pinned: false,
    updatedAt: day,
  },
];

const plan = {
  operations: [
    {
      op: "merge" as const,
      ids: ["a1", "a2"],
      content: "  Refunds over $500 go\nto billing. ",
    },
    { op: "keep" as const, id: "a3" },
    { op: "delete" as const, id: "a4", reason: "Not about the job." },
  ],
};

describe("checkCompaction", () => {
  it("accepts a plan that accounts for every entry, keeps the pinned ones and fits the target", () => {
    const checked = checkCompaction(plan, entries, 100);

    expect(checked.chars).toBe(32 + 26);
    expect(checked.plan.operations[0]).toEqual({
      op: "merge",
      ids: ["a1", "a2"],
      content: "Refunds over $500 go to billing.",
    });
  });

  it("refuses every way a plan can lose or alter what it must not", () => {
    const cases: Array<[typeof plan, string]> = [
      [{ operations: plan.operations.slice(0, 2) }, "missing: a4"],
      [
        { operations: [...plan.operations, { op: "keep", id: "a9" }] },
        "Entry a9 does not exist.",
      ],
      [
        { operations: [...plan.operations, { op: "keep", id: "a1" }] },
        "Entry a1 appears more than once.",
      ],
      [
        {
          operations: [
            plan.operations[0],
            { op: "delete", id: "a3", reason: "old" },
            plan.operations[2],
          ],
        },
        "Entry a3 is pinned",
      ],
      [
        {
          operations: [
            { op: "merge", ids: ["a1", "a2"], content: "x".repeat(501) },
            ...plan.operations.slice(1),
          ],
        },
        "an entry holds at most 500",
      ],
    ];
    for (const [candidate, error] of cases)
      expect(() => checkCompaction(candidate, entries, 1000)).toThrow(error);
    expect(() => checkCompaction(plan, entries, 50)).toThrow(
      "The result has 58 characters; it must fit in 50.",
    );
  });
});

describe("planCompaction", () => {
  const usage = {
    inputTokens: {
      total: 100,
      noCache: 100,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  };
  const answer = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
    warnings: [],
  });
  let model: MockLanguageModelV4;
  const script = (rounds: unknown[]) => {
    model = new MockLanguageModelV4({ doGenerate: rounds as never });
    vi.mocked(buildProvider).mockReturnValue(model as never);
  };

  beforeEach(() => vi.clearAllMocks());

  it("retries once with the reason the first answer was rejected", async () => {
    script([answer({ operations: plan.operations.slice(0, 2) }), answer(plan)]);

    const result = await planCompaction({
      model: "test/model",
      purpose: "Lessons.",
      entries,
      target: 100,
    });

    expect(result.chars).toBe(58);
    expect(result.inputTokens).toBe(200);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
      "Your previous answer was rejected: Every entry needs an operation; missing: a4.",
    );
  });

  it("gives up after the second rejection, reporting what both attempts cost", async () => {
    script([answer({ nope: true }), answer({ operations: [] })]);

    const failure = planCompaction({
      model: "test/model",
      purpose: "Lessons.",
      entries,
      target: 100,
    });

    await expect(failure).rejects.toBeInstanceOf(CompactionError);
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining("The compaction failed twice"),
      inputTokens: 200,
      outputTokens: 40,
    });
  });

  it("tells the model the target, the purpose and which entries are pinned", () => {
    const prompt = compactionPrompt({
      purpose: "Lessons.",
      entries,
      target: 4800,
    });

    expect(prompt).toMatch(
      /^Consolidate this memory to at most 4800 characters\./,
    );
    expect(prompt).toContain("Purpose of this memory: Lessons.");
    expect(prompt).toContain(
      "- [a3] PINNED (2026-10-10) Never call the legacy API.",
    );
  });
});
