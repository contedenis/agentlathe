import { describe, expect, it } from "vitest";
import {
  EARLIER_HEADER,
  evaluationInput,
  THIS_RUN_HEADER,
} from "./evaluation-input";

function fullState(input: unknown, output: unknown): string {
  const result = evaluationInput(input, output);
  if (!("state" in result)) throw new Error("expected a state");
  return result.state;
}

function stateOf(input: unknown, output: unknown): string {
  const state = fullState(input, output);
  expect(state.startsWith(`${THIS_RUN_HEADER}\n`)).toBe(true);
  return state.slice(THIS_RUN_HEADER.length + 1);
}

const userTurn = (text: string) => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text }],
});

const assistantTurn = (parts: unknown[]) => ({
  id: "a1",
  role: "assistant",
  parts,
});

describe("evaluationInput — the transcript as the judge reads it", () => {
  it("serializes a dashboard run as USER / ASSISTANT lines, skipping empty text, reasoning and step-start", () => {
    const state = stateOf(
      [userTurn("I was charged twice")],
      [
        assistantTurn([
          { type: "step-start" },
          { type: "reasoning", text: "thinking hard" },
          { type: "text", text: "   " },
          { type: "text", text: "Let me check." },
        ]),
      ],
    );

    expect(state).toBe("USER: I was charged twice\nASSISTANT: Let me check.");
  });

  it("renders each tool state with its marker", () => {
    const state = stateOf(
      [userTurn("refund order 7")],
      [
        assistantTurn([
          {
            type: "tool-search_orders",
            toolCallId: "c1",
            state: "output-available",
            input: { orderId: "7" },
            output: { charges: 2 },
          },
          {
            type: "tool-charge",
            toolCallId: "c2",
            state: "output-error",
            input: { amount: 1 },
            errorText: "HTTP 500: boom",
          },
          {
            type: "tool-issue_refund",
            toolCallId: "c3",
            state: "output-denied",
            input: { orderId: "7" },
            approval: { id: "ap1", approved: false },
          },
          {
            type: "tool-issue_refund",
            toolCallId: "c4",
            state: "approval-responded",
            input: { orderId: "8" },
            approval: { id: "ap2", approved: false },
          },
          {
            type: "dynamic-tool",
            toolName: "docs__search",
            toolCallId: "c5",
            state: "output-available",
            input: { q: "refunds" },
            output: "policy text",
          },
          { type: "text", text: "Done." },
        ]),
      ],
    );

    expect(state.split("\n")).toEqual([
      "USER: refund order 7",
      'TOOL CALL search_orders({"orderId":"7"}) -> {"charges":2}',
      'TOOL CALL charge({"amount":1}) -> ERROR: HTTP 500: boom',
      'TOOL CALL issue_refund({"orderId":"7"}) -> DENIED by the user',
      'TOOL CALL issue_refund({"orderId":"8"}) -> DENIED by the user',
      'TOOL CALL docs__search({"q":"refunds"}) -> policy text',
      "ASSISTANT: Done.",
    ]);
  });

  it("caps tool inputs and outputs at 2000 chars, saying how much was cut", () => {
    const state = stateOf(
      [],
      [
        assistantTurn([
          {
            type: "tool-dump",
            toolCallId: "c1",
            state: "output-available",
            input: "i".repeat(2005),
            output: "o".repeat(3000),
          },
        ]),
      ],
    );

    expect(state).toBe(
      `TOOL CALL dump(${"i".repeat(2000)} …[truncated 5 chars]) -> ${"o".repeat(2000)} …[truncated 1000 chars]`,
    );
  });

  it("does not truncate a value of exactly 2000 chars", () => {
    const state = stateOf(
      [],
      [
        assistantTurn([
          {
            type: "tool-dump",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: "o".repeat(2000),
          },
        ]),
      ],
    );

    expect(state).toBe(`TOOL CALL dump({}) -> ${"o".repeat(2000)}`);
  });

  it("reads a /v1 run: ModelMessage tool-call/tool-result parts, unwrapped outputs, headless denials", () => {
    const state = stateOf(
      [
        { role: "system", content: "You are support." },
        { role: "user", content: "refund order 7" },
      ],
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "search_orders",
              input: { orderId: "7" },
            },
            {
              type: "tool-call",
              toolCallId: "c2",
              toolName: "issue_refund",
              input: { orderId: "7" },
            },
            {
              type: "tool-call",
              toolCallId: "c3",
              toolName: "charge",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "search_orders",
              output: { type: "json", value: { charges: 2 } },
            },
            {
              type: "tool-result",
              toolCallId: "c2",
              toolName: "issue_refund",
              output: {
                type: "execution-denied",
                reason:
                  "tool 'issue_refund' requires approval; not available over the API",
              },
            },
            {
              type: "tool-result",
              toolCallId: "c3",
              toolName: "charge",
              output: { type: "error-text", value: "HTTP 402: no funds" },
            },
          ],
        },
        { role: "assistant", content: "I could not refund it." },
      ],
    );

    expect(state.split("\n")).toEqual([
      "USER: refund order 7",
      "ASSISTANT: Checking.",
      'TOOL CALL search_orders({"orderId":"7"}) -> {"charges":2}',
      'TOOL CALL issue_refund({"orderId":"7"}) -> DENIED by the user',
      "TOOL CALL charge({}) -> ERROR: HTTP 402: no funds",
      "ASSISTANT: I could not refund it.",
    ]);
  });

  it("reads an MCP run: plain role/content messages", () => {
    expect(
      stateOf(
        [{ role: "user", content: "hola" }],
        [{ role: "assistant", content: "¡Hola!" }],
      ),
    ).toBe("USER: hola\nASSISTANT: ¡Hola!");
  });

  it("detects a run that ends paused on a pending approval", () => {
    expect(
      evaluationInput(
        [userTurn("refund order 7")],
        [
          assistantTurn([
            { type: "text", text: "I need approval." },
            {
              type: "tool-issue_refund",
              toolCallId: "c1",
              state: "approval-requested",
              input: { orderId: "7" },
              approval: { id: "ap1" },
            },
          ]),
        ],
      ),
    ).toEqual({ awaitingApproval: true });
  });

  it("detects a pending approval anywhere in the final assistant message, not only in its last tool part", () => {
    expect(
      evaluationInput(
        [userTurn("refund order 7")],
        [
          assistantTurn([
            {
              type: "tool-issue_refund",
              toolCallId: "c1",
              state: "approval-requested",
              input: { orderId: "7" },
              approval: { id: "ap1" },
            },
            {
              type: "tool-search_orders",
              toolCallId: "c2",
              state: "output-available",
              input: {},
              output: "ok",
            },
          ]),
        ],
      ),
    ).toEqual({ awaitingApproval: true });
  });

  it("an approval answered and continued in this run reads as executed, with the final answer", () => {
    const state = stateOf(
      [userTurn("refund order 7")],
      [
        assistantTurn([
          {
            type: "tool-issue_refund",
            toolCallId: "c1",
            state: "output-available",
            input: { orderId: "7" },
            output: "refunded",
            approval: { id: "ap1", approved: true },
          },
          { type: "text", text: "Refund issued." },
        ]),
      ],
    );

    expect(state.split("\n")).toEqual([
      "USER: refund order 7",
      'TOOL CALL issue_refund({"orderId":"7"}) -> refunded',
      "ASSISTANT: Refund issued.",
    ]);
  });

  it("renders a dashboard tool output verbatim even when it looks like a ModelMessage result", () => {
    const state = stateOf(
      [userTurn("look it up")],
      [
        assistantTurn([
          {
            type: "tool-lookup",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { type: "error-text", value: "a field named type" },
          },
        ]),
      ],
    );

    expect(state).toContain(
      'TOOL CALL lookup({}) -> {"type":"error-text","value":"a field named type"}',
    );
  });

  it("a pause in an earlier turn is not this run's pause", () => {
    const result = evaluationInput(
      [
        { ...userTurn("refund order 7"), id: "u0" },
        assistantTurn([
          {
            type: "tool-issue_refund",
            toolCallId: "c1",
            state: "approval-requested",
            input: { orderId: "7" },
            approval: { id: "ap1" },
          },
        ]),
        { ...userTurn("never mind"), id: "u2" },
      ],
      [{ id: "a2", role: "assistant", parts: [{ type: "text", text: "Ok." }] }],
    );

    expect(result).not.toEqual({ awaitingApproval: true });
  });
});

describe("evaluationInput — judging the run, not the whole thread", () => {
  it("renders earlier turns as user-only context and the run from the last user message on", () => {
    const state = fullState(
      [
        { role: "system", content: "You are support." },
        { role: "user", content: "can I get a refund for order 7?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "search_orders", arguments: '{"orderId":"7"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: '{"paid":true}' },
        { role: "assistant", content: "Sure, your refund is on its way!" },
        { role: "user", content: "thanks, and what are your hours?" },
      ],
      [{ role: "assistant", content: "We open 9 to 5." }],
    );

    expect(state.split("\n")).toEqual([
      EARLIER_HEADER,
      "USER: can I get a refund for order 7?",
      "",
      THIS_RUN_HEADER,
      "USER: thanks, and what are your hours?",
      "ASSISTANT: We open 9 to 5.",
    ]);
    expect(state).not.toContain("refund is on its way");
    expect(state).not.toContain("search_orders");
  });

  it("omits the earlier section when the run is the whole conversation", () => {
    const state = fullState(
      [{ role: "user", content: "hola" }],
      [{ role: "assistant", content: "¡Hola!" }],
    );

    expect(state).not.toContain(EARLIER_HEADER);
    expect(state).toBe(`${THIS_RUN_HEADER}\nUSER: hola\nASSISTANT: ¡Hola!`);
  });

  it("keeps only the most recent ~6000 chars of earlier context", () => {
    const earlier = Array.from({ length: 10 }, (_, index) => [
      { role: "user", content: `question ${index} ${"x".repeat(1000)}` },
      { role: "assistant", content: "answer" },
    ]).flat();

    const state = fullState(
      [...earlier, { role: "user", content: "last question" }],
      [{ role: "assistant", content: "last answer" }],
    );

    const [earlierSection, runSection] = state.split(
      `\n\n${THIS_RUN_HEADER}\n`,
    );
    expect(earlierSection.split("\n").slice(0, 2)).toEqual([
      EARLIER_HEADER,
      "…[earlier messages omitted]",
    ]);
    expect(earlierSection).toContain("question 9 ");
    expect(earlierSection).not.toContain("question 0 ");
    expect(earlierSection.length).toBeLessThan(6000 + 200);
    expect(runSection).toBe("USER: last question\nASSISTANT: last answer");
  });
});
