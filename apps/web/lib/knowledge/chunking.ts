import { CHUNK_OVERLAP, CHUNK_SIZE } from "@agentlathe/db";

export type Chunk = { position: number; page: number | null; content: string };

export function chunkPages(
  pages: string[],
  { paged }: { paged: boolean },
): Chunk[] {
  let text = "";
  const pageStarts: { offset: number; page: number }[] = [];
  pages.forEach((raw, index) => {
    const page = raw.replace(/\s+/g, " ").trim();
    if (!page) return;
    if (text) text += " ";
    pageStarts.push({ offset: text.length, page: index + 1 });
    text += page;
  });

  const pageAt = (offset: number) => {
    let page = pageStarts[0]?.page ?? 1;
    for (const start of pageStarts) {
      if (start.offset > offset) break;
      page = start.page;
    }
    return page;
  };

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + CHUNK_SIZE / 2) end = space;
    }
    chunks.push({
      position: chunks.length,
      page: paged ? pageAt(start) : null,
      content: text.slice(start, end).trim(),
    });
    if (end >= text.length) break;
    let next = end - CHUNK_OVERLAP;
    const space = text.indexOf(" ", next);
    if (space >= 0 && space < end) next = space + 1;
    start = Math.max(next, start + 1);
  }
  return chunks;
}
