import { describe, expect, it } from "vitest";
import { evaluateScript } from "./sandbox-vm";

describe("evaluateScript", () => {
  it("runs the script body with the input and returns its value and logs", async () => {
    const outcome = await evaluateScript(
      "console.log('adding', input); return { sum: input.a + input.b };",
      { a: 2, b: 3 },
      1000,
    );

    expect(outcome).toEqual({
      ok: true,
      result: { sum: 5 },
      logs: ['adding {"a":2,"b":3}'],
    });
  });

  it("reports an error the script throws, with the logs before it", async () => {
    const outcome = await evaluateScript(
      "console.log('before'); throw new RangeError('too big');",
      null,
      1000,
    );

    expect(outcome).toEqual({
      ok: false,
      error: "RangeError: too big",
      logs: ["before"],
    });
  });

  it("reports a syntax error", async () => {
    const outcome = await evaluateScript("return {;", null, 1000);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({
      error: expect.stringContaining("SyntaxError"),
    });
  });

  it("stops an endless loop at the time limit, even inside a try/catch", async () => {
    const startedAt = Date.now();
    const outcome = await evaluateScript(
      "while (true) { try { while (true) {} } catch {} }",
      null,
      200,
    );

    expect(outcome).toEqual({
      ok: false,
      error: "The script ran out of time.",
      logs: [],
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("fails a script that allocates past the memory limit, without the process growing past it", async () => {
    const before = process.memoryUsage().rss;
    let peak = before;
    const watch = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);

    const outcomes = [
      await evaluateScript(
        "const parts = []; for (;;) parts.push(new ArrayBuffer(8_000_000));",
        null,
        5000,
      ),
      await evaluateScript(
        "const parts = []; for (;;) parts.push('x'.repeat(1_000_000) + parts.length);",
        null,
        5000,
      ),
    ];
    clearInterval(watch);

    for (const outcome of outcomes) expect(outcome.ok).toBe(false);
    expect(peak - before).toBeLessThan(200 * 1024 * 1024);
  });

  it("refuses a script that returns a promise or a function instead of a value", async () => {
    for (const script of [
      "return Promise.resolve(5);",
      "return (async () => 5)();",
      "return () => 5;",
    ])
      expect(await evaluateScript(script, null, 1000)).toMatchObject({
        ok: false,
        error: expect.stringContaining("it cannot be async"),
      });
  });

  it("hands the input over as data: a __proto__ key stays a key", async () => {
    const outcome = await evaluateScript(
      "return [Object.keys(input), input.amount ?? null];",
      JSON.parse('{"__proto__": {"amount": 5}}'),
      1000,
    );

    expect(outcome).toMatchObject({ result: [["__proto__"], null] });
  });

  it("reports a thrown value that is not an Error", async () => {
    expect(
      await evaluateScript("throw { code: 7 };", null, 1000),
    ).toMatchObject({ ok: false, error: '{"code":7}' });
  });

  it("gives the script nothing of the host", async () => {
    const outcome = await evaluateScript(
      "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.Deno, typeof module];",
      null,
      1000,
    );

    expect(outcome).toMatchObject({
      result: [
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
      ],
    });
  });

  it("keeps one run's globals out of the next", async () => {
    await evaluateScript("globalThis.leak = 1; return 1;", null, 1000);
    const outcome = await evaluateScript("return typeof leak;", null, 1000);

    expect(outcome).toMatchObject({ result: "undefined" });
  });
});
