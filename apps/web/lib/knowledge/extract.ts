import { type KnowledgeMediaType, PAGE_BREAK } from "@agentlathe/db";
import { extractText, getDocumentProxy } from "unpdf";

const MIN_PAGE_CHARS = 10;
const PDF_SIGNATURE = "%PDF-";

const EXTENSIONS: Record<string, KnowledgeMediaType> = {
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};

export class UnreadableDocumentError extends Error {}

function decodeUtf8(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function detectMediaType(
  filename: string,
  bytes: Uint8Array,
): { mediaType: KnowledgeMediaType } | { error: string } {
  const extension = filename.includes(".")
    ? filename.toLowerCase().split(".").pop()
    : undefined;
  const mediaType = extension ? EXTENSIONS[extension] : undefined;
  if (!mediaType)
    return {
      error:
        "Only PDF, Markdown (.md) and plain-text (.txt) files are supported.",
    };
  if (mediaType === "application/pdf")
    return new TextDecoder("latin1").decode(bytes.subarray(0, 5)) ===
      PDF_SIGNATURE
      ? { mediaType }
      : { error: "The file has a .pdf extension but is not a PDF." };
  return decodeUtf8(bytes) === null
    ? { error: "Markdown and text files must be UTF-8 text." }
    : { mediaType };
}

export async function extractDocument(
  bytes: Uint8Array,
  mediaType: KnowledgeMediaType,
): Promise<{ text: string; pages: number | null }> {
  if (mediaType !== "application/pdf") {
    const text = decodeUtf8(bytes);
    if (text === null)
      throw new UnreadableDocumentError("The file is not valid UTF-8 text.");
    if (!text.trim()) throw new UnreadableDocumentError("The file is empty.");
    return { text, pages: null };
  }

  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      ({ text: pages } = await extractText(pdf, { mergePages: false }));
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (err) {
    throw new UnreadableDocumentError(
      `Could not read the PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const clean = pages.map((page) => page.replaceAll(PAGE_BREAK, " "));
  const pagesWithText = clean.filter(
    (page) => page.replace(/\s/g, "").length >= MIN_PAGE_CHARS,
  ).length;
  if (pagesWithText === 0 || pagesWithText * 2 < clean.length)
    throw new UnreadableDocumentError("No text found. Is it a scanned PDF?");
  return { text: clean.join(PAGE_BREAK), pages: clean.length };
}

export function documentPages(
  text: string,
  mediaType: KnowledgeMediaType,
): string[] {
  return mediaType === "application/pdf" ? text.split(PAGE_BREAK) : [text];
}
