import { describe, expect, it } from "vitest";
import { isUuid } from "./uuid";

describe("isUuid — the gate every route uses to answer 400 instead of querying", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
    expect(isUuid("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("rejects anything that is not exactly that shape", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid("f47ac10b58cc4372a5670e02b2c3d479")).toBe(false);
    expect(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d47")).toBe(false);
    expect(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d4799")).toBe(false);
    expect(isUuid("g47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });

  it("anchors both ends, so padded input does not slip through", () => {
    expect(isUuid(" f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
    expect(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479 ")).toBe(false);
    expect(isUuid("x/f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });
});
