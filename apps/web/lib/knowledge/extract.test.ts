import { PAGE_BREAK } from "@agentlathe/db";
import { describe, expect, it } from "vitest";
import { makePdf } from "../../tests/pdf-fixture";
import {
  detectMediaType,
  documentPages,
  extractDocument,
  UnreadableDocumentError,
} from "./extract";

const utf8 = (text: string) => new TextEncoder().encode(text);
const POLICY =
  "Gifts over $250 must be politely declined and logged in the register.";

describe("detectMediaType", () => {
  it("accepts a PDF by extension and signature", () => {
    expect(detectMediaType("Policy.PDF", makePdf([POLICY]))).toEqual({
      mediaType: "application/pdf",
    });
  });

  it("rejects a .pdf that is not a PDF", () => {
    expect(detectMediaType("fake.pdf", utf8("hello"))).toEqual({
      error: "The file has a .pdf extension but is not a PDF.",
    });
  });

  it("accepts UTF-8 Markdown and text, and rejects binary content", () => {
    expect(detectMediaType("notes.md", utf8("# Título"))).toEqual({
      mediaType: "text/markdown",
    });
    expect(detectMediaType("notes.markdown", utf8("x"))).toEqual({
      mediaType: "text/markdown",
    });
    expect(detectMediaType("notes.txt", utf8("plain"))).toEqual({
      mediaType: "text/plain",
    });
    expect(
      detectMediaType("latin1.txt", new Uint8Array([0x63, 0x61, 0xf1, 0x61])),
    ).toEqual({ error: "Markdown and text files must be UTF-8 text." });
    expect(detectMediaType("nul.txt", new Uint8Array([0x61, 0, 0x62]))).toEqual(
      { error: "Markdown and text files must be UTF-8 text." },
    );
  });

  it("rejects other formats and files without an extension", () => {
    for (const name of ["data.csv", "photo.png", "README", "archive.pdf.zip"])
      expect(detectMediaType(name, utf8("a,b"))).toHaveProperty("error");
  });
});

describe("extractDocument", () => {
  it("returns text files as they are, without a page count", async () => {
    await expect(
      extractDocument(utf8("﻿# Notes\n\nLine"), "text/markdown"),
    ).resolves.toEqual({ text: "# Notes\n\nLine", pages: null });
  });

  it("fails an empty text file", async () => {
    await expect(extractDocument(utf8(" \n"), "text/plain")).rejects.toThrow(
      UnreadableDocumentError,
    );
  });

  it("extracts each PDF page, separated by a page break", async () => {
    const { text, pages } = await extractDocument(
      makePdf([POLICY, "Expense reports are due within 30 days of travel."]),
      "application/pdf",
    );
    expect(pages).toBe(2);
    const split = documentPages(text, "application/pdf");
    expect(split).toHaveLength(2);
    expect(split[0]).toContain("Gifts over $250");
    expect(split[1]).toContain("within 30 days");
    expect(text.split(PAGE_BREAK)).toEqual(split);
  });

  it("fails a PDF without a text layer", async () => {
    await expect(
      extractDocument(makePdf(["", "12"]), "application/pdf"),
    ).rejects.toThrow("No text found. Is it a scanned PDF?");
  });

  it("accepts a slide deck with short titles and fails a mostly scanned PDF", async () => {
    await expect(
      extractDocument(
        makePdf(["Q3 Results 1", "Q3 Results 2", "Q3 Results 3"]),
        "application/pdf",
      ),
    ).resolves.toMatchObject({ pages: 3 });
    await expect(
      extractDocument(makePdf([POLICY, "", "", "7"]), "application/pdf"),
    ).rejects.toThrow("No text found. Is it a scanned PDF?");
  });

  it("fails a corrupt PDF as unreadable", async () => {
    await expect(
      extractDocument(utf8("%PDF-1.4\ngarbage"), "application/pdf"),
    ).rejects.toThrow(UnreadableDocumentError);
  });

  it("keeps a Markdown document as one page", () => {
    expect(documentPages(`a${PAGE_BREAK}b`, "text/markdown")).toEqual([
      `a${PAGE_BREAK}b`,
    ]);
  });
});
