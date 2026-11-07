import { describe, expect, it } from "vitest";
import { alwaysReadUsage } from "./knowledge-modes";

const chars: Record<string, number> = { a: 40_000, b: 100_000, c: 999_999 };

describe("alwaysReadUsage", () => {
  it("adds up only the collections read whole, against a quarter of the context", () => {
    expect(
      alwaysReadUsage(
        [
          { collectionId: "a", mode: "always" },
          { collectionId: "b", mode: "always" },
          { collectionId: "c", mode: "search" },
        ],
        (id) => chars[id],
        200_000,
      ),
    ).toEqual({ tokens: 35_000, budget: 50_000, fits: true });
  });

  it("assumes the runtime's default context when the model's is unknown", () => {
    expect(
      alwaysReadUsage(
        [{ collectionId: "c", mode: "always" }],
        (id) => chars[id],
        null,
      ),
    ).toEqual({ tokens: 250_000, budget: 32_000, fits: false });
  });
});
