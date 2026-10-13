export type JudgedStatus = "pass" | "fail" | "needs_review" | "not_applicable";

export type Thresholds = { failBelow: number; passAbove: number };

export function deriveStatus(
  thresholds: Thresholds,
  pPass: number,
  pApplies: number | null,
): JudgedStatus {
  const { failBelow, passAbove } = thresholds;
  if (pApplies !== null) {
    if (pApplies < failBelow) return "not_applicable";
    if (pApplies < passAbove) return "needs_review";
  }
  if (pPass < failBelow) return "fail";
  if (pPass >= passAbove) return "pass";
  return "needs_review";
}
