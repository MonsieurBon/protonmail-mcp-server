/**
 * Readable text for an email body.
 *
 * Many mails (Outlook, newsletters, ticketing tools) carry only an HTML part.
 * mailparser leaves `parsed.text` empty for those, so without a fallback the
 * body and the list snippet come out empty although the mail has content.
 */

import { convert } from "html-to-text";
import type { ParsedMail } from "mailparser";

const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    // Inline images are usually signatures/logos, often as huge data: URIs.
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
    // Hidden preheader/tracking blocks
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" }
  ]
};

export function htmlToPlainText(html: string): string {
  return convert(html, HTML_TO_TEXT_OPTIONS)
    .replace(/[ ​-‍͏﻿]+/g, " ") // nbsp and zero-width filler
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The plain-text part if there is one, otherwise the HTML part converted to text. */
export function bodyText(parsed: Pick<ParsedMail, "text" | "html">): string {
  const text = parsed.text?.trim();
  if (text) return text;
  if (typeof parsed.html === "string" && parsed.html.trim()) {
    return htmlToPlainText(parsed.html);
  }
  return "";
}

/** Replace inline data: URIs (base64 images) so returned HTML stays small. */
export function stripDataUris(html: string): string {
  return html.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:…");
}
