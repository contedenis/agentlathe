import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";

const WASM_PAGE_BYTES = 64 * 1024;
export const SCRIPT_MEMORY_BYTES = 64 * 1024 * 1024;
export const SCRIPT_STACK_BYTES = 512 * 1024;
const MAX_LOG_CHARS = 4_000;
export const OUT_OF_TIME = "The script ran out of time.";

export type ScriptOutcome =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

let quickjs: Promise<QuickJSWASMModule> | null = null;

// setMemoryLimit counts allocations, not bytes, in this build: the WebAssembly
// memory's own maximum is the bound that holds.
type WasmMemory = NonNullable<
  Awaited<Parameters<typeof newVariant>[1]["wasmMemory"]>
>;

function loadQuickJS(): Promise<QuickJSWASMModule> {
  const { Memory } = (
    globalThis as unknown as {
      WebAssembly: {
        Memory: new (limits: { initial: number; maximum: number }) => unknown;
      };
    }
  ).WebAssembly;
  return newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: new Memory({
        initial: 256,
        maximum: SCRIPT_MEMORY_BYTES / WASM_PAGE_BYTES,
      }) as WasmMemory,
    }),
  );
}

const PRELUDE = `
const __logs = [];
let __logChars = 0;
const __show = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
};
const __log = (...args) => {
  if (__logChars >= ${MAX_LOG_CHARS}) return;
  const line = args.map(__show).join(" ").slice(0, ${MAX_LOG_CHARS} - __logChars);
  __logChars += line.length + 1;
  __logs.push(line);
};
globalThis.console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };
`;

export async function evaluateScript(
  script: string,
  input: unknown,
  timeoutMs: number,
): Promise<ScriptOutcome> {
  quickjs ??= loadQuickJS();
  const runtime = (await quickjs).newRuntime();
  runtime.setMaxStackSize(SCRIPT_STACK_BYTES);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + timeoutMs),
  );
  const context = runtime.newContext();
  try {
    const source = `${PRELUDE}
let __outcome;
try {
  const __result = (function (input) {
${script}
})(JSON.parse(${JSON.stringify(JSON.stringify(input ?? null))}));
  if (typeof __result === "function" || (__result && typeof __result.then === "function"))
    throw new TypeError("The script must return a JSON value, not a function or a promise: it cannot be async.");
  __outcome = { ok: true, result: __result === undefined ? null : __result, logs: __logs };
} catch (error) {
  __outcome = { ok: false, error: error instanceof Error ? error.name + ": " + error.message : __show(error), logs: __logs };
}
JSON.stringify(__outcome);`;
    const evaluated = context.evalCode(source, "skill.js");
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: describeVmError(error), logs: [] };
    }
    const text = context.getString(evaluated.value);
    evaluated.value.dispose();
    return JSON.parse(text) as ScriptOutcome;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

function describeVmError(error: unknown): string {
  if (error && typeof error === "object") {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (message === "interrupted") return OUT_OF_TIME;
    if (typeof message === "string")
      return typeof name === "string" ? `${name}: ${message}` : message;
  }
  return String(error);
}
