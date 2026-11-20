import { describe, it, expect } from "vitest";
import {
  attachmentKind,
  extractAttachmentText,
  UnsupportedAttachmentError,
  MAX_ATTACHMENT_BYTES,
  joinTextItems,
  decodeText
} from "./attachment-text.js";

type Run = { x: number; y: number; text: string };

/**
 * A minimal valid PDF (Helvetica, ASCII only). A page is either one line of
 * text, or separately positioned runs with no space characters between them,
 * the way Word and many other generators lay out words.
 */
function makePdf(pages: Array<string | Run[]>): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const pageId = pageIds[i];
    const runs: Run[] = typeof text === "string" ? [{ x: 72, y: 720, text }] : text;
    const stream = runs
      .map((r) => `BT /F1 12 Tf 1 0 0 1 ${r.x} ${r.y} Tm (${r.text}) Tj ET`)
      .join("\n");
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

  it("reads words placed as separate runs with spaces and lines (Copilot review)", async () => {
    const pdf = makePdf([[
      { x: 72, y: 720, text: "Hello" },
      { x: 110, y: 720, text: "world" },
      { x: 72, y: 700, text: "Zweite" },
      { x: 120, y: 700, text: "Zeile" }
    ]]);
    const r = await extractAttachmentText(pdf, "application/pdf", "word.pdf");
    expect(r.text).toBe("Hello world\nZweite Zeile");
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

  it("decodes a Windows-1252 CSV without a declared charset (Copilot review)", async () => {
    const csv = Buffer.from([0x47, 0x72, 0xfc, 0x73, 0x73, 0x65, 0x3b, 0x80]); // "Grüsse;€"
    expect((await extractAttachmentText(csv, "text/csv", "export.csv")).text).toBe("Grüsse;€");
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

describe("joinTextItems", () => {
  const at = (str: string, x: number, y: number, width: number, hasEOL = false) =>
    ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12, hasEOL });

  it("inserts a space for a gap between runs on the same baseline", () => {
    expect(joinTextItems([at("Hello", 72, 720, 30), at("world", 110, 720, 28)])).toBe("Hello world");
  });

  it("starts a new line when y jumps without an end-of-line flag", () => {
    expect(joinTextItems([at("Zeile1", 72, 720, 36), at("Zeile2", 72, 700, 36)])).toBe("Zeile1\nZeile2");
  });

  it("keeps words that pdf.js already split with spaces intact", () => {
    expect(joinTextItems([at("Hello ", 72, 720, 33), at("world", 105, 720, 28)])).toBe("Hello world");
  });

  it("does not split a word whose pieces touch", () => {
    expect(joinTextItems([at("Feuer", 72, 720, 30), at("wehr", 102, 720, 25)])).toBe("Feuerwehr");
  });

  it("follows hasEOL and empty end-of-line markers", () => {
    expect(joinTextItems([at("A", 72, 720, 8), at("", 80, 720, 0, true), at("B", 72, 706, 8)])).toBe("A\nB");
  });
});

describe("decodeText", () => {
  it("uses the declared charset", () => {
    expect(decodeText(Buffer.from([0xe4]), "ISO-8859-1")).toBe("ä");
  });
  it("prefers valid UTF-8 when nothing is declared", () => {
    expect(decodeText(Buffer.from("Grüsse", "utf8"))).toBe("Grüsse");
  });
  it("ignores an unknown charset label", () => {
    expect(decodeText(Buffer.from("ok"), "x-bogus")).toBe("ok");
  });
});
