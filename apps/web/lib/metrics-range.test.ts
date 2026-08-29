import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RANGE_DAYS,
  parseMetricsRange,
  periodLabel,
  previousRangeStart,
  rangeHref,
  rangeQuery,
} from "./metrics-range";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseMetricsRange — presets", () => {
  it("defaults to the 30-day preset ending today", () => {
    const range = parseMetricsRange({});
    expect(range.preset).toBe(30);
    expect(range.days).toHaveLength(30);
    expect(range.to).toBe("2026-08-15");
    expect(range.from).toBe("2026-07-17");
  });

  it("accepts a listed preset and rejects arbitrary day counts", () => {
    expect(parseMetricsRange({ days: "7" }).preset).toBe(7);
    expect(parseMetricsRange({ days: "12" }).preset).toBe(30);
    expect(parseMetricsRange({ days: "banana" }).preset).toBe(30);
  });
});

describe("parseMetricsRange — custom ranges", () => {
  it("builds an inclusive day window with no preset", () => {
    const range = parseMetricsRange({ from: "2026-08-01", to: "2026-08-03" });
    expect(range.preset).toBeNull();
    expect(range.days).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(range.since.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.until.toISOString()).toBe("2026-08-03T23:59:59.999Z");
  });

  it("swaps an inverted from/to", () => {
    const range = parseMetricsRange({ from: "2026-08-10", to: "2026-08-05" });
    expect(range.from).toBe("2026-08-05");
    expect(range.to).toBe("2026-08-10");
  });

  it("clamps a future 'to' back to today", () => {
    const range = parseMetricsRange({ from: "2026-08-10", to: "2026-12-31" });
    expect(range.to).toBe("2026-08-15");
  });

  it("caps the window at MAX_RANGE_DAYS", () => {
    const range = parseMetricsRange({ from: "2020-01-01", to: "2026-08-15" });
    expect(range.days).toHaveLength(MAX_RANGE_DAYS);
    expect(range.to).toBe("2026-08-15");
  });

  it("an invalid date string falls back instead of exploding", () => {
    const range = parseMetricsRange({ from: "2026-13-99", to: "2026-08-10" });
    expect(range.from).toBe("2026-08-10");
    expect(range.to).toBe("2026-08-10");
  });
});

describe("previousRangeStart — the comparison window", () => {
  it("starts exactly one window-length before the range", () => {
    const range = parseMetricsRange({ from: "2026-08-11", to: "2026-08-15" });
    expect(previousRangeStart(range).toISOString()).toBe(
      "2026-08-06T00:00:00.000Z",
    );
  });
});

describe("periodLabel", () => {
  it("names a preset range by day count", () => {
    expect(periodLabel(parseMetricsRange({ days: "7" }))).toBe(
      "the last 7 days",
    );
  });

  it("spells out a custom range with both dates", () => {
    const range = parseMetricsRange({ from: "2026-08-01", to: "2026-08-03" });
    expect(periodLabel(range)).toBe("08/01/2026 to 08/03/2026 (3 days)");
  });
});

describe("range URLs", () => {
  it("presets serialize as days=, custom ranges as from/to", () => {
    expect(rangeQuery(parseMetricsRange({ days: "7" }))).toBe("days=7");
    expect(
      rangeQuery(parseMetricsRange({ from: "2026-08-01", to: "2026-08-03" })),
    ).toBe("from=2026-08-01&to=2026-08-03");
    expect(rangeHref("/metrics", parseMetricsRange({ days: "90" }))).toBe(
      "/metrics?days=90",
    );
  });
});
