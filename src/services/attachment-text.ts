/**
 * Text extraction from email attachments.
 *
 * Attachments are untrusted input. PDFs are parsed with pdf.js 6, which no
 * longer has the eval-based font path behind CVE-2024-4367, with XFA,
 * system fonts, font loading, worker fetches and range requests off. Nothing
 * is written to disk and nothing is executed.
 */

import { htmlToPlainText } from "./body-text.js";

/** Attachments larger than this are refused before parsing. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** PDF pages beyond this are not extracted. */
export const MAX_PDF_PAGES = 50;

export interface AttachmentText {
  kind: "pdf" | "text" | "html";
  text: string;
  /** Total page count for PDFs */
  pages?: number;
  /** True if pages were skipped because of MAX_PDF_PAGES */
  pagesTruncated?: boolean;
}

export class UnsupportedAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAttachmentError";
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function attachmentKind(contentType: string, filename: string): AttachmentText["kind"] | null {
  const type = contentType.toLowerCase().split(";")[0].trim();
  const ext = extensionOf(filename);
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === "text/html" || ext === "html" || ext === "htm") return "html";
  if (
    type.startsWith("text/") ||
    ["txt", "csv", "tsv", "md", "ics", "vcf", "json", "xml", "log"].includes(ext)
  ) {
    return "text";
  }
  return null;
}

async function pdfToText(data: Uint8Array): Promise<Omit<AttachmentText, "kind">> {
  // Lazy import: pdf.js is large and only needed when a PDF is opened.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0
  });
  const doc = await task.promise;
  try {
    const pageCount = doc.numPages;
    const last = Math.min(pageCount, MAX_PDF_PAGES);
    const parts: string[] = [];
    for (let n = 1; n <= last; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) =>
        "str" in item
          ? [{ str: item.str, transform: item.transform as number[], width: item.width, height: item.height, hasEOL: item.hasEOL }]
          : []
      );
      const text = joinTextItems(items).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      parts.push(pageCount > 1 ? `--- Seite ${n} ---\n${text}` : text);
      page.cleanup();
    }
    return { text: parts.join("\n\n").trim(), pages: pageCount, pagesTruncated: pageCount > last };
  } finally {
    await task.destroy();
  }
}

export interface PositionedText {
  str: string;
  /** [a, b, c, d, x, y] text matrix; x/y is the item's origin in PDF units */
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

/**
 * Join pdf.js text items into lines. Many generators (Word among them) place
 * each word as its own item with no space character between them, so a gap
 * on the same baseline becomes a space, and a jump in y becomes a new line,
 * even when pdf.js did not flag an end of line.
 */
export function joinTextItems(items: PositionedText[]): string {
  const lines: string[] = [];
  let line = "";
  let prev: { x: number; y: number; end: number; size: number } | null = null;
  for (const item of items) {
    const [, , c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || item.height || 10;
    if (item.str) {
      if (prev) {
        if (Math.abs(y - prev.y) > Math.max(size, prev.size) * 0.5) {
          lines.push(line);
          line = "";
        } else if (
          x - prev.end > Math.max(size, prev.size) * 0.15 &&
          !/\s$/.test(line) &&
          !/^\s/.test(item.str)
        ) {
          line += " ";
        }
      }
      line += item.str;
      prev = { x, y, end: x + item.width, size };
    }
    if (item.hasEOL) {
      lines.push(line);
      line = "";
      prev = null;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/**
 * Decode a text attachment. Uses the declared charset when there is one;
 * otherwise UTF-8 if the bytes are valid UTF-8, else Windows-1252 (what old
 * Excel CSV exports and many Swiss/German tools write).
 */
export function decodeText(content: Buffer, charset?: string): string {
  const bytes = new Uint8Array(content);
  if (charset) {
    try {
      return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
    } catch {
      // unknown label: fall through to detection
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function extractAttachmentText(
  content: Buffer,
  contentType: string,
  filename: string,
  charset?: string
): Promise<AttachmentText> {
  const kind = attachmentKind(contentType, filename);
  if (!kind) {
    throw new UnsupportedAttachmentError(
      `Cannot read '${filename}' (${contentType}). Supported: PDF, plain text (txt, csv, ics, …) and HTML.`
    );
  }
  if (content.length > MAX_ATTACHMENT_BYTES) {
    throw new UnsupportedAttachmentError(
      `'${filename}' is ${Math.round(content.length / 1024 / 1024)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`
    );
  }
  switch (kind) {
    case "pdf":
      return { kind, ...(await pdfToText(new Uint8Array(content))) };
    case "html":
      return { kind, text: htmlToPlainText(decodeText(content, charset)) };
    case "text":
      return { kind, text: decodeText(content, charset).replace(/^\uFEFF/, "").trim() };
  }
}
