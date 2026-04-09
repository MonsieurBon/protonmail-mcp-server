/**
 * Shared formatting utilities for converting email data
 * into markdown or JSON response strings.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import type {
  EmailMessage,
  EmailFull,
  EmailAddress,
  FolderInfo,
  PaginatedResult
} from "../types.js";
import { ResponseFormat } from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────

function formatAddress(addr: EmailAddress): string {
  if (addr.name) return `${addr.name} <${addr.address}>`;
  return addr.address;
}

function formatAddressList(addrs: EmailAddress[]): string {
  return addrs.map(formatAddress).join(", ") || "(none)";
}

function formatDate(iso: string): string {
  if (!iso) return "(unknown date)";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return iso;
  }
}

function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT - 100) +
    "\n\n---\n⚠️ Response truncated. Use pagination or narrower search to see more results."
  );
}

// ── Folder formatting ───────────────────────────────────────────

export function formatFolders(
  folders: FolderInfo[],
  format: ResponseFormat
): string {
  if (format === ResponseFormat.JSON) {
    return truncateIfNeeded(JSON.stringify(folders, null, 2));
  }

  if (!folders.length) return "No folders found.";

  const lines = ["# Mailbox Folders", ""];
  for (const f of folders) {
    const unseen = f.unseenCount > 0 ? ` (${f.unseenCount} unread)` : "";
    lines.push(`- **${f.path}** — ${f.messageCount} messages${unseen}`);
  }
  return truncateIfNeeded(lines.join("\n"));
}

// ── Email list formatting ───────────────────────────────────────

export function formatEmailList(
  result: PaginatedResult<EmailMessage>,
  folder: string,
  format: ResponseFormat
): string {
  if (format === ResponseFormat.JSON) {
    return truncateIfNeeded(JSON.stringify(result, null, 2));
  }

  if (!result.items.length) {
    return `No emails found in **${folder}** (offset ${result.offset}).`;
  }

  const lines = [
    `# ${folder} — ${result.total} emails (showing ${result.count}, offset ${result.offset})`,
    ""
  ];

  for (const email of result.items) {
    const read = email.flags.includes("\\Seen") ? "" : "🔵 ";
    const flagged = email.flags.includes("\\Flagged") ? "⭐ " : "";
    const attach = email.hasAttachments ? " 📎" : "";

    lines.push(`### ${read}${flagged}${email.subject}${attach}`);
    lines.push(`- **From:** ${formatAddressList(email.from)}`);
    lines.push(`- **Date:** ${formatDate(email.date)}`);
    lines.push(`- **UID:** ${email.uid}`);
    if (email.snippet) {
      lines.push(`- ${email.snippet}`);
    }
    lines.push("");
  }

  if (result.has_more) {
    lines.push(
      `---\n*${result.total - result.offset - result.count} more emails available. Use offset=${result.next_offset} to see the next page.*`
    );
  }

  return truncateIfNeeded(lines.join("\n"));
}

// ── Single email formatting ─────────────────────────────────────

export function formatEmailFull(
  email: EmailFull,
  format: ResponseFormat
): string {
  if (format === ResponseFormat.JSON) {
    return truncateIfNeeded(JSON.stringify(email, null, 2));
  }

  const lines = [
    `# ${email.subject}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| **From** | ${formatAddressList(email.from)} |`,
    `| **To** | ${formatAddressList(email.to)} |`,
    ...(email.cc.length
      ? [`| **Cc** | ${formatAddressList(email.cc)} |`]
      : []),
    `| **Date** | ${formatDate(email.date)} |`,
    `| **Folder** | ${email.folder} |`,
    `| **UID** | ${email.uid} |`,
    ""
  ];

  if (email.attachments.length) {
    lines.push("## Attachments");
    for (const att of email.attachments) {
      const sizeKb = Math.round(att.size / 1024);
      lines.push(`- ${att.filename} (${att.contentType}, ${sizeKb} KB)`);
    }
    lines.push("");
  }

  lines.push("## Body", "", email.body || "(no plain text body)");

  return truncateIfNeeded(lines.join("\n"));
}
