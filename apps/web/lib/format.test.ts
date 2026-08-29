import { describe, expect, it } from "vitest";
import { compact, fmt, formatCost, formatDay, formatDuration } from "./format";

describe("formatDuration — the second is the unit boundary", () => {
  it("stays in milliseconds below one second", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("switches to seconds with one decimal at exactly 1000", () => {
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(1540)).toBe("1.5 s");
    expect(formatDuration(60_000)).toBe("60.0 s");
  });
});

describe("formatCost — a missing cost and a free run read differently", () => {
  it("renders an em dash for null and a bare zero for free", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).toBe("$0");
  });

  it("uses four decimals under a cent so sub-cent runs are not all $0.00", () => {
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(0.0099)).toBe("$0.0099");
  });

  it("uses two decimals from a cent up", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("compact — thousands round, millions keep a decimal", () => {
  it("leaves values below a thousand untouched", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999)).toBe("999");
  });

  it("rounds to k from a thousand up", () => {
    expect(compact(1000)).toBe("1k");
    expect(compact(1500)).toBe("2k");
    expect(compact(999_999)).toBe("1000k");
  });

  it("switches to M at a million", () => {
    expect(compact(1_000_000)).toBe("1.0M");
    expect(compact(2_350_000)).toBe("2.4M");
  });
});

describe("formatDay — ISO day to US order", () => {
  it("reorders year-month-day into month/day/year", () => {
    expect(formatDay("2026-01-15")).toBe("01/15/2026");
    expect(formatDay("2026-12-31")).toBe("12/31/2026");
  });
});

describe("fmt", () => {
  it("groups thousands", () => {
    expect(fmt(1000)).toBe("1,000");
    expect(fmt(1_234_567)).toBe("1,234,567");
    expect(fmt(0)).toBe("0");
  });
});
