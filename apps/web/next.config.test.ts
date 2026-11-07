import { MAX_DOCUMENT_BYTES } from "@agentlathe/db";
import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("next.config", () => {
  it("lets a document of the maximum size through proxy.ts whole", () => {
    const limit = String(nextConfig.experimental?.proxyClientMaxBodySize);
    const [, megabytes] = limit.match(/^(\d+)mb$/) ?? [];
    expect(Number(megabytes) * 1024 * 1024).toBeGreaterThan(
      MAX_DOCUMENT_BYTES + 64 * 1024,
    );
  });
});
