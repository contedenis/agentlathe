import { describe, expect, it } from "vitest";
import { hasRunsFilter, parseRunsFilter, runsFilterQuery } from "./runs-filter";

const AGENT = "0b6f6c0e-3c58-4b56-9d0a-0d8c1f5f2a11";

describe("parseRunsFilter", () => {
  it("is empty without parameters", () => {
    const filter = parseRunsFilter({});

    expect(filter).toEqual({
      q: "",
      source: "",
      subject: "",
      evaluation: "",
      agent: "",
      attention: false,
    });
    expect(hasRunsFilter(filter)).toBe(false);
  });

  it("drops values it does not know, so a hand-edited URL never reaches the query", () => {
    expect(
      parseRunsFilter({
        source: "carrier-pigeon",
        evaluation: "maybe",
        agent: "not-a-uuid",
        attention: "yes",
      }),
    ).toMatchObject({
      source: "",
      evaluation: "",
      agent: "",
      attention: false,
    });
  });

  it("round-trips through the query string", () => {
    const filter = parseRunsFilter({
      q: " support ",
      source: "v1",
      subject: "user-7",
      evaluation: "needs_review",
      agent: AGENT,
      attention: "1",
    });

    const query = runsFilterQuery(filter);
    expect(query).toBe(
      `?q=support&source=v1&subject=user-7&evaluation=needs_review&agent=${AGENT}&attention=1`,
    );
    expect(
      parseRunsFilter(Object.fromEntries(new URLSearchParams(query))),
    ).toEqual(filter);
  });
});

describe("runsFilterQuery", () => {
  it("adds the page only past the first", () => {
    const filter = parseRunsFilter({ attention: "1" });

    expect(runsFilterQuery(filter, 1)).toBe("?attention=1");
    expect(runsFilterQuery(filter, 3)).toBe("?attention=1&page=3");
    expect(runsFilterQuery(parseRunsFilter({}))).toBe("");
  });
});
