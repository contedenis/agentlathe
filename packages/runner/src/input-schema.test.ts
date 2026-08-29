import { describe, expect, it } from "vitest";
import { compileInputSchema, describeSchemaErrors } from "./input-schema";

describe("compileInputSchema", () => {
  it("compiles a valid schema into a working validator", () => {
    const validate = compileInputSchema({
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
      additionalProperties: false,
    });

    expect(validate).not.toBeNull();
    expect(validate?.({ amount: 3 })).toBe(true);
    expect(validate?.({ amount: "3" })).toBe(false);
    expect(validate?.({ amount: 3, extra: true })).toBe(false);
  });

  it("returns null for a schema that is not compilable", () => {
    expect(compileInputSchema({ type: "not-a-type" })).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(compileInputSchema(null)).toBeNull();
    expect(compileInputSchema("{}")).toBeNull();
  });

  it("tolerates unknown keywords instead of rejecting the schema", () => {
    expect(
      compileInputSchema({ type: "object", "x-internal": true }),
    ).not.toBeNull();
  });
});

describe("describeSchemaErrors", () => {
  it("renders the failing paths and messages", () => {
    const validate = compileInputSchema({
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
    });
    if (!validate) throw new Error("the schema should compile");
    validate({});

    expect(describeSchemaErrors(validate)).toContain(
      "must have required property 'amount'",
    );
  });
});
