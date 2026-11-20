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
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      const text = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      parts.push(pageCount > 1 ? `--- Seite ${n} ---\n${text}` : text);
      page.cleanup();
    }
    return { text: parts.join("\n\n").trim(), pages: pageCount, pagesTruncated: pageCount > last };
  } finally {
    await task.destroy();
  }
}

export async function extractAttachmentText(
  content: Buffer,
  contentType: string,
  filename: string
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
      return { kind, text: htmlToPlainText(content.toString("utf8")) };
    case "text":
      return { kind, text: content.toString("utf8").trim() };
  }
}
