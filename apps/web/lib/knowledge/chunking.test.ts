import { CHUNK_OVERLAP, CHUNK_SIZE } from "@agentlathe/db";
import { describe, expect, it } from "vitest";
import { chunkPages } from "./chunking";

const words = (count: number, prefix = "w") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");

describe("chunkPages", () => {
  it("returns nothing for empty pages", () => {
    expect(chunkPages(["", "  \n "], { paged: true })).toEqual([]);
  });

  it("keeps a short document in one chunk and collapses whitespace", () => {
    expect(chunkPages(["Hello\n\n  world\t!"], { paged: false })).toEqual([
      { position: 0, page: null, content: "Hello world !" },
    ]);
  });

  it("cuts at word boundaries with the configured size and overlap", () => {
    const text = words(600);
    const chunks = chunkPages([text], { paged: false });
    expect(chunks.length).toBeGreaterThan(3);
    const all = new Set(text.split(" "));
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.position).toBe(i);
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_SIZE);
      for (const word of chunk.content.split(" ")) expect(all).toContain(word);
    }
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1].content;
      const firstWord = chunks[i].content.split(" ")[0];
      const shared = previous.slice(previous.lastIndexOf(` ${firstWord} `));
      expect(shared.length).toBeGreaterThan(CHUNK_OVERLAP - 20);
      expect(shared.length).toBeLessThanOrEqual(CHUNK_OVERLAP + 1);
    }
    expect(chunks.at(-1)?.content.endsWith("w599")).toBe(true);
  });

  it("joins pages so a sentence crossing a page stays in one chunk", () => {
    const chunks = chunkPages(["The refund limit", "is $500."], {
      paged: true,
    });
    expect(chunks).toEqual([
      { position: 0, page: 1, content: "The refund limit is $500." },
    ]);
  });

  it("records the page where each chunk starts, skipping empty pages", () => {
    const chunks = chunkPages([words(150, "a"), "", words(150, "c")], {
      paged: true,
    });
    expect(chunks[0].page).toBe(1);
    const firstOnThird = chunks.find((chunk) => chunk.content.startsWith("c"));
    expect(firstOnThird?.page).toBe(3);
    expect(chunks.every((chunk) => chunk.page !== 2)).toBe(true);
  });

  it("splits a word longer than a chunk instead of looping", () => {
    const chunks = chunkPages(["x".repeat(CHUNK_SIZE * 2 + 10)], {
      paged: false,
    });
    expect(chunks.map((chunk) => chunk.content.length)).toEqual([
      CHUNK_SIZE,
      CHUNK_SIZE,
      CHUNK_OVERLAP * 2 + 10,
    ]);
  });
});
