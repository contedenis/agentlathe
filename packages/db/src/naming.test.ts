import { describe, expect, it } from "vitest";
import {
  AGENT_SLUG_MAX_LENGTH,
  AGENT_SLUG_PATTERN,
  agentAskToolName,
  agentSlug,
  httpToolName,
  mcpToolName,
  slug,
  subAgentToolName,
} from "./naming";

describe("slug", () => {
  it("collapses spaces to underscores", () => {
    expect(slug("my mcp server")).toBe("my_mcp_server");
  });

  it("strips accents instead of mangling them", () => {
    expect(slug("Café/Résumé!!")).toBe("Cafe_Resume");
  });

  it("trims leading/trailing underscores produced by invalid boundary chars", () => {
    expect(slug("  hello  ")).toBe("hello");
  });

  it("keeps already-valid characters untouched", () => {
    expect(slug("valid-name_123")).toBe("valid-name_123");
  });

  it("always matches ^[a-zA-Z0-9_-]*$", () => {
    expect(slug("weird!! ñame @@ 2024")).toMatch(/^[a-zA-Z0-9_-]*$/);
  });

  it("is idempotent", () => {
    const once = slug("My MCP Server!!");
    expect(slug(once)).toBe(once);
  });
});

describe("agentSlug", () => {
  it("lowercases and hyphenates a display name", () => {
    expect(agentSlug("Support Bot")).toBe("support-bot");
  });

  it("strips accents instead of hyphenating them away", () => {
    expect(agentSlug("Analista de Métricas")).toBe("analista-de-metricas");
  });

  it("keeps dots, underscores and hyphens that are already valid", () => {
    expect(agentSlug("agent.v2_final-1")).toBe("agent.v2_final-1");
  });

  it("collapses any run of out-of-set characters into a single hyphen", () => {
    expect(agentSlug("Café / Résumé!! 2024")).toBe("cafe-resume-2024");
  });

  it("trims separators from both ends", () => {
    expect(agentSlug("  ...my agent___  ")).toBe("my-agent");
  });

  it("falls back to 'agent' when nothing survives", () => {
    expect(agentSlug("!!!")).toBe("agent");
    expect(agentSlug("")).toBe("agent");
    expect(agentSlug("   ")).toBe("agent");
  });

  it("truncates to AGENT_SLUG_MAX_LENGTH", () => {
    expect(agentSlug("a".repeat(100))).toBe("a".repeat(AGENT_SLUG_MAX_LENGTH));
  });

  it("re-trims a separator left dangling by the truncation", () => {
    const name = `${"a".repeat(AGENT_SLUG_MAX_LENGTH - 1)} b`;
    expect(agentSlug(name)).toBe("a".repeat(AGENT_SLUG_MAX_LENGTH - 1));
  });

  it("always produces a slug that AGENT_SLUG_PATTERN accepts", () => {
    const names = [
      "Support Bot",
      "  ...my agent___  ",
      "!!!",
      "",
      "ÁÉÍÓÚ ñandú",
      "___",
      "---",
      "...",
      "a",
      "1",
      "___lead and trail___",
      "tabs\tand\nnewlines",
      "emoji 🚀 agent",
      "汉字 only",
      "a".repeat(200),
      `${"b".repeat(AGENT_SLUG_MAX_LENGTH - 1)} c`,
      `${"c".repeat(AGENT_SLUG_MAX_LENGTH)}.d`,
      "MiXeD CaSe / Slashes \\ Backslashes",
      "100% coverage?",
      "agent.v2_final-1",
    ];

    for (const name of names) {
      const result = agentSlug(name);
      expect(result.length).toBeLessThanOrEqual(AGENT_SLUG_MAX_LENGTH);
      expect(result).toMatch(AGENT_SLUG_PATTERN);
    }
  });
});

describe("httpToolName", () => {
  it("slugs the free-text tool name", () => {
    expect(httpToolName("Fetch URL!")).toBe("Fetch_URL");
  });

  it("falls back to 'tool' when nothing survives", () => {
    expect(httpToolName("!!!")).toBe("tool");
  });
});

describe("mcpToolName", () => {
  it("prefixes the remote tool name with the slugged server name", () => {
    expect(mcpToolName("My MCP Server", "list_issues")).toBe(
      "My_MCP_Server__list_issues",
    );
  });

  it("leaves the remote tool name untouched", () => {
    expect(mcpToolName("gh", "repos.list")).toBe("gh__repos.list");
  });
});

describe("subAgentToolName", () => {
  it("prefixes an agent slug unchanged", () => {
    expect(subAgentToolName("response-writer")).toBe(
      "subagent_response-writer",
    );
  });

  it("slugs a dot out of an agent slug", () => {
    expect(subAgentToolName("agent.v2")).toBe("subagent_agent_v2");
  });
});

describe("agentAskToolName", () => {
  it("lowercases the slugged agent name", () => {
    expect(agentAskToolName("Response writer")).toBe("ask_response_writer");
  });

  it("strips accents", () => {
    expect(agentAskToolName("Analista de Métricas")).toBe(
      "ask_analista_de_metricas",
    );
  });

  it("caps the base at 50 characters", () => {
    expect(agentAskToolName("a".repeat(80))).toBe(`ask_${"a".repeat(50)}`);
  });

  it("falls back to ask_agent when nothing survives", () => {
    expect(agentAskToolName("!!!")).toBe("ask_agent");
  });
});
