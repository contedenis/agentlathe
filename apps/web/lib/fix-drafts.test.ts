import { describe, expect, it } from "vitest";
import { anchorKey, fixDraftUpdateSchema, toFixDrafts } from "./fix-drafts";

type Row = Parameters<typeof toFixDrafts>[0][number];

const CREATED_AT = new Date("2026-01-15T10:00:00.000Z");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "draft-1",
    messageId: "msg-1",
    anchor: { type: "turn" },
    category: "prompt",
    rationale: "The tone is off",
    proposedValue: null,
    status: "open",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("toFixDrafts — rows that fail the shape are dropped, not surfaced", () => {
  it("maps a valid row and serializes createdAt", () => {
    const drafts = toFixDrafts([
      row({
        anchor: { type: "tool_call", toolCallId: "call-9" },
        proposedValue: "Ask for the city first.",
      }),
    ]);

    expect(drafts).toEqual([
      {
        id: "draft-1",
        messageId: "msg-1",
        anchor: { type: "tool_call", toolCallId: "call-9" },
        category: "prompt",
        rationale: "The tone is off",
        proposedValue: "Ask for the city first.",
        status: "open",
        createdAt: CREATED_AT.toISOString(),
      },
    ]);
  });

  it("drops a row whose anchor is not a known shape", () => {
    expect(toFixDrafts([row({ anchor: { type: "selection" } })])).toEqual([]);
    expect(toFixDrafts([row({ anchor: { type: "tool_call" } })])).toEqual([]);
    expect(toFixDrafts([row({ anchor: null })])).toEqual([]);
  });

  it("drops a row whose category or status left the enum", () => {
    expect(toFixDrafts([row({ category: "legacy_category" })])).toEqual([]);
    expect(toFixDrafts([row({ status: "archived" })])).toEqual([]);
  });

  it("drops a row with an empty rationale", () => {
    expect(toFixDrafts([row({ rationale: "" })])).toEqual([]);
  });

  it("keeps the sound rows when one of them is corrupt", () => {
    const drafts = toFixDrafts([
      row({ id: "draft-1" }),
      row({ id: "draft-2", category: "legacy_category" }),
      row({ id: "draft-3" }),
    ]);

    expect(drafts.map((draft) => draft.id)).toEqual(["draft-1", "draft-3"]);
  });

  it("falls back to the current time when createdAt is null", () => {
    const [draft] = toFixDrafts([row({ createdAt: null })]);

    expect(draft).toBeDefined();
    expect(Number.isNaN(Date.parse(draft.createdAt))).toBe(false);
  });
});

describe("fixDraftUpdateSchema — partial edits", () => {
  it("accepts a status-only change", () => {
    expect(fixDraftUpdateSchema.safeParse({ status: "applied" }).success).toBe(
      true,
    );
  });

  it("accepts editing content fields without touching status", () => {
    const parsed = fixDraftUpdateSchema.safeParse({
      category: "model",
      rationale: "Different reason",
      proposedValue: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(fixDraftUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty rationale", () => {
    expect(fixDraftUpdateSchema.safeParse({ rationale: "" }).success).toBe(
      false,
    );
  });
});

describe("anchorKey — the join key between a draft and what the UI renders", () => {
  it("keys a tool_call anchor by tool call id, ignoring the message", () => {
    expect(
      anchorKey("msg-1", { type: "tool_call", toolCallId: "call-9" }),
    ).toBe("tool:call-9");
    expect(
      anchorKey("msg-2", { type: "tool_call", toolCallId: "call-9" }),
    ).toBe("tool:call-9");
  });

  it("keys a turn anchor by message id", () => {
    expect(anchorKey("msg-1", { type: "turn" })).toBe("msg:msg-1");
  });

  it("never collides across the two anchor types", () => {
    expect(anchorKey("x", { type: "turn" })).not.toBe(
      anchorKey("x", { type: "tool_call", toolCallId: "x" }),
    );
  });
});
