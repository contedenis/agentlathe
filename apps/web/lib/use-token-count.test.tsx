import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTokenCount } from "./use-token-count";

vi.mock("ai-tokenizer", () => ({
  models: {},
  Tokenizer: class {
    count(text: string) {
      return text.length;
    }
  },
}));
vi.mock("ai-tokenizer/encoding/o200k_base", () => ({}));

describe("useTokenCount", () => {
  it("computes a token count once the encoding module resolves", async () => {
    const { result } = renderHook(() =>
      useTokenCount("hello world", "test-model"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tokens).toBe("hello world".length);
  });

  it("reports 0 tokens for empty text", async () => {
    const { result } = renderHook(() => useTokenCount("", "test-model"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tokens).toBe(0);
  });
});
