import { describe, expect, it } from "vitest";
import { deriveStatus } from "./evaluation-verdict";

const thresholds = { failBelow: 0.2, passAbove: 0.8 };

describe("deriveStatus — p_pass and thresholds to a verdict", () => {
  it.each([
    [0.01, "fail"],
    [0.19, "fail"],
    [0.2, "needs_review"],
    [0.5, "needs_review"],
    [0.79, "needs_review"],
    [0.8, "pass"],
    [0.99, "pass"],
  ] as const)("p_pass %s → %s", (pPass, status) => {
    expect(deriveStatus(thresholds, pPass, null)).toBe(status);
  });

  it("checks applicability before the verdict", () => {
    expect(deriveStatus(thresholds, 0.01, 0.1)).toBe("not_applicable");
    expect(deriveStatus(thresholds, 0.99, 0.19)).toBe("not_applicable");
    expect(deriveStatus(thresholds, 0.99, 0.2)).toBe("needs_review");
    expect(deriveStatus(thresholds, 0.01, 0.79)).toBe("needs_review");
    expect(deriveStatus(thresholds, 0.01, 0.8)).toBe("fail");
    expect(deriveStatus(thresholds, 0.99, 0.95)).toBe("pass");
  });

  it("uses the criterion's own thresholds", () => {
    const strict = { failBelow: 0.5, passAbove: 0.95 };
    expect(deriveStatus(strict, 0.4, null)).toBe("fail");
    expect(deriveStatus(strict, 0.9, null)).toBe("needs_review");
    expect(deriveStatus(strict, 0.95, null)).toBe("pass");
  });

  it("equal thresholds leave no review band", () => {
    const sharp = { failBelow: 0.5, passAbove: 0.5 };
    expect(deriveStatus(sharp, 0.49, null)).toBe("fail");
    expect(deriveStatus(sharp, 0.5, null)).toBe("pass");
  });
});
