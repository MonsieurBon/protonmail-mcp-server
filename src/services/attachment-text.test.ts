import { describe, it, expect } from "vitest";
import {
  attachmentKind,
  extractAttachmentText,
  UnsupportedAttachmentError,
  MAX_ATTACHMENT_BYTES
} from "./attachment-text.js";

/** A minimal valid PDF with one text line per page (Helvetica, ASCII only). */
function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const pageId = pageIds[i];
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("attachmentKind", () => {
  it.each([
    ["application/pdf", "x.bin", "pdf"],
    ["application/octet-stream", "Aufgebot.PDF", "pdf"],
    ["text/plain", "a.txt", "text"],
    ["application/octet-stream", "termin.ics", "text"],
    ["text/html", "a.html", "html"],
    ["image/png", "a.png", null],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", null]
  ])("%s / %s -> %s", (type, name, kind) => {
    expect(attachmentKind(type, name)).toBe(kind);
  });
});

describe("extractAttachmentText", () => {
  it("reads a one-page PDF", async () => {
    const r = await extractAttachmentText(makePdf(["Kommissionssitzung 26.11.2026, 19:30"]), "application/pdf", "Aufgebot.pdf");
    expect(r.kind).toBe("pdf");
    expect(r.pages).toBe(1);
    expect(r.text).toBe("Kommissionssitzung 26.11.2026, 19:30");
  });

  it("marks pages in a multi-page PDF", async () => {
    const r = await extractAttachmentText(makePdf(["Erste Seite", "Zweite Seite"]), "application/pdf", "a.pdf");
    expect(r.pages).toBe(2);
    expect(r.text).toBe("--- Seite 1 ---\nErste Seite\n\n--- Seite 2 ---\nZweite Seite");
  });

  it("returns empty text for a PDF without a text layer", async () => {
    const r = await extractAttachmentText(makePdf([""]), "application/pdf", "scan.pdf");
    expect(r.text).toBe("");
  });

  it("rejects a corrupt PDF with an error instead of hanging", async () => {
    await expect(
      extractAttachmentText(Buffer.from("%PDF-1.4 not really"), "application/pdf", "bad.pdf")
    ).rejects.toThrow();
  });

  it("reads text and HTML attachments", async () => {
    expect((await extractAttachmentText(Buffer.from(" Hallo \n"), "text/plain", "a.txt")).text).toBe("Hallo");
    expect((await extractAttachmentText(Buffer.from("<p>Hallo <b>Welt</b></p>"), "text/html", "a.html")).text).toBe("Hallo Welt");
  });

  it("refuses unsupported types and oversized files", async () => {
    await expect(extractAttachmentText(Buffer.from("x"), "image/png", "a.png")).rejects.toBeInstanceOf(UnsupportedAttachmentError);
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    await expect(extractAttachmentText(big, "text/plain", "big.txt")).rejects.toThrow(/limit/);
  });
});
