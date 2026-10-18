import { describe, expect, it } from "vitest";
import { SOURCE_LABEL, SOURCE_ORDER, sourceLabel } from "./run-sources";

describe("sourceLabel", () => {
  it("maps every known source to its display label", () => {
    expect(sourceLabel("dashboard")).toBe("Playground");
    expect(sourceLabel("v1")).toBe("API /v1");
    expect(sourceLabel("mcp")).toBe("MCP");
    expect(sourceLabel("schedule")).toBe("Scheduled");
  });

  it("falls back to the raw value for a source it does not know", () => {
    expect(sourceLabel("cron")).toBe("cron");
    expect(sourceLabel("")).toBe("");
  });

  it("labels every source listed in SOURCE_ORDER", () => {
    for (const source of SOURCE_ORDER) {
      expect(SOURCE_LABEL[source]).toBeTruthy();
    }
  });
});
