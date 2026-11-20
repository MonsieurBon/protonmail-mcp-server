import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { bodyText, htmlToPlainText, stripDataUris } from "./body-text.js";

// Shaped like the Outlook mails that came through empty: an HTML part plus an
// inline signature image in multipart/related, and no text/plain part at all.
// For this shape mailparser leaves `text` undefined.
const htmlOnlyMail = [
  "From: André Blanc <feuerwehr@example.ch>",
  "To: Fabian <fabian@example.ch>",
  "Subject: Test",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/html; charset="iso-8859-1"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<html><head><style>P {margin:0}</style></head><body>",
  "<div>Hallo Jasmin</div><div><br></div>",
  "<div>Am 20. Oktober 2026 hattest du die =C4rztliche Untersuchung.&nbsp;</div>",
  '<p><img src=3D"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=3D=3D"></p>',
  '<a href=3D"mailto:feuerwehr@example.ch">feuerwehr@example.ch</a>',
  "</body></html>",
  "--b1",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <image001>",
  "",
  "iVBORw0KGgo=",
  "--b1--"
].join("\r\n");

describe("bodyText", () => {
  it("falls back to the HTML part when a mail has no plain-text part", async () => {
    const parsed = await simpleParser(htmlOnlyMail);
    expect(parsed.text?.trim() ?? "").toBe(""); // the bug this guards against
    const text = bodyText(parsed);
    expect(text).toContain("Hallo Jasmin");
    expect(text).toContain("Am 20. Oktober 2026 hattest du die Ärztliche Untersuchung.");
    expect(text).toContain("feuerwehr@example.ch");
    expect(text).not.toContain("base64");
    expect(text).not.toContain("margin");
  });

  it("prefers the plain-text part when there is one", () => {
    expect(bodyText({ text: "plain", html: "<p>html</p>" })).toBe("plain");
  });

  it("returns an empty string when there is no body at all", () => {
    expect(bodyText({ text: undefined, html: false })).toBe("");
  });

  it("collapses blank lines and zero-width filler from newsletters", () => {
    expect(htmlToPlainText("<p>A</p><p>‌‌</p><br><br><p>B</p>")).toBe("A\n\nB");
  });
});

describe("stripDataUris", () => {
  it("replaces inline base64 images", () => {
    expect(stripDataUris('<img src="data:image/png;base64,AAAA+/==">')).toBe('<img src="data:…">');
  });
});
