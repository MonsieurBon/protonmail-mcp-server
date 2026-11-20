/**
 * IMAP client service for connecting to Proton Bridge.
 *
 * Proton Bridge exposes a standard IMAP interface on localhost,
 * allowing us to read mail without touching Proton's proprietary API.
 */

import { ImapFlow, MailboxObject } from "imapflow";
import { simpleParser, ParsedMail, AddressObject, Attachment } from "mailparser";
import { bodyText, stripDataUris } from "./body-text.js";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  CONNECTION_TIMEOUT,
} from "../constants.js";
import type {
  EmailMessage,
  EmailFull,
  EmailAddress,
  AttachmentInfo,
  FolderInfo
} from "../types.js";

/** IMAP connection configuration from environment variables */
interface ImapConfig {
  host: string;
  port: number;
  auth: {
    user: string;
    pass: string;
  };
  secure: boolean;
  tls: {
    rejectUnauthorized: boolean;
  };
  logger: false;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

function getConfig(): ImapConfig {
  const user = process.env.PROTON_BRIDGE_USER;
  const pass = process.env.PROTON_BRIDGE_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "Missing PROTON_BRIDGE_USER or PROTON_BRIDGE_PASSWORD environment variables. " +
      "These are your Proton Bridge credentials (not your Proton account password). " +
      "Find them in Proton Bridge > Account > IMAP/SMTP settings."
    );
  }

  const host = process.env.PROTON_BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST;

  const portEnv = process.env.PROTON_BRIDGE_PORT;
  const port = portEnv !== undefined ? parseInt(portEnv, 10) : DEFAULT_BRIDGE_PORT;
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PROTON_BRIDGE_PORT: "${portEnv}". Must be between 1 and 65535.`);
  }

  const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "::1";

  return {
    host,
    port,
    auth: { user, pass },
    secure: false, // Bridge uses STARTTLS
    tls: {
      rejectUnauthorized: !isLocalhost // Only skip TLS validation for localhost (Bridge self-signed certs)
    },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT,
    greetingTimeout: CONNECTION_TIMEOUT,
    socketTimeout: CONNECTION_TIMEOUT
  };
}

/**
 * Execute a callback with a connected IMAP client.
 * Handles connection lifecycle automatically.
 */
export async function withClient<T>(
  callback: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const config = getConfig();
  const client = new ImapFlow(config);

  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.logout().catch(() => {
      // Suppress logout errors during cleanup
    });
  }
}

/** Convert mailparser address objects to our EmailAddress type */
function parseAddresses(
  addressObj: AddressObject | undefined
): EmailAddress[] {
  if (!addressObj || !addressObj.value) return [];
  return addressObj.value.map((addr: { name?: string; address?: string }) => ({
    name: addr.name ?? "",
    address: addr.address ?? ""
  }));
}

/** Extract a plain-text snippet from a parsed email */
function extractSnippet(parsed: ParsedMail, maxLength = 200): string {
  const text = bodyText(parsed);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + "...";
}

/** Convert a parsed email into our EmailMessage type */
function toEmailMessage(
  uid: number,
  parsed: ParsedMail,
  folder: string,
  flags: Set<string> | undefined
): EmailMessage {
  const flagSet = flags ?? new Set<string>();
  return {
    uid,
    messageId: parsed.messageId ?? "",
    subject: parsed.subject ?? "(no subject)",
    from: parseAddresses(parsed.from),
    to: parseAddresses(
      Array.isArray(parsed.to) ? parsed.to[0] : parsed.to
    ),
    cc: parseAddresses(
      Array.isArray(parsed.cc) ? parsed.cc[0] : parsed.cc
    ),
    date: parsed.date?.toISOString() ?? "",
    folder,
    flags: Array.from(flagSet),
    snippet: extractSnippet(parsed),
    hasAttachments: (parsed.attachments?.length ?? 0) > 0
  };
}

/** Maximum HTML size to include in response (prevents context exhaustion) */
const MAX_HTML_LENGTH = 10000;

/** Convert a parsed email into our EmailFull type */
function toEmailFull(
  uid: number,
  parsed: ParsedMail,
  folder: string,
  flags: Set<string> | undefined
): EmailFull {
  let html = stripDataUris(parsed.html || "");
  if (html.length > MAX_HTML_LENGTH) {
    html = html.slice(0, MAX_HTML_LENGTH) + "\n<!-- HTML truncated -->";
  }

  return {
    ...toEmailMessage(uid, parsed, folder, flags),
    body: bodyText(parsed),
    html,
    attachments: (parsed.attachments ?? []).map(
      (att: Attachment): AttachmentInfo => ({
        filename: att.filename ?? "unnamed",
        contentType: att.contentType ?? "application/octet-stream",
        size: att.size ?? 0
      })
    )
  };
}

// ── Public API ──────────────────────────────────────────────────

/** Mailbox tree item from imapflow listTree() */
interface ListTreeMailbox {
  name: string;
  path: string;
  delimiter?: string;
  flags?: Set<string>;
  folders?: ListTreeMailbox[];
}

/**
 * List all mailbox folders with message counts.
 */
export async function listFolders(): Promise<FolderInfo[]> {
  return withClient(async (client) => {
    const tree = await client.listTree();
    const folders: FolderInfo[] = [];

    async function walk(
      items: ListTreeMailbox[]
    ): Promise<void> {
      for (const item of items) {
        // Try to get status (message counts)
        let messageCount = 0;
        let unseenCount = 0;
        try {
          const status = await client.status(item.path, {
            messages: true,
            unseen: true
          });
          messageCount = status.messages ?? 0;
          unseenCount = status.unseen ?? 0;
        } catch {
          // Some folders (e.g., root namespace) may not support STATUS
        }

        folders.push({
          name: item.name,
          path: item.path,
          delimiter: item.delimiter ?? "/",
          messageCount,
          unseenCount,
          flags: Array.from(item.flags ?? new Set())
        });

        if (item.folders && item.folders.length > 0) {
          await walk(item.folders);
        }
      }
    }

    await walk(tree.folders as ListTreeMailbox[]);
    return folders;
  });
}

/**
 * List emails in a folder with pagination, sorted newest first.
 */
export async function listEmails(
  folder: string,
  limit: number,
  offset: number
): Promise<{ total: number; emails: EmailMessage[] }> {
  return withClient(async (client) => {
    const mailbox = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const total = (client.mailbox as MailboxObject)?.exists ?? 0;

      if (total === 0 || offset >= total) {
        return { total, emails: [] };
      }

      // IMAP sequence numbers are 1-based, newest = highest
      const endSeq = total - offset;
      const startSeq = Math.max(1, endSeq - limit + 1);

      if (endSeq < 1) {
        return { total, emails: [] };
      }

      const range = `${startSeq}:${endSeq}`;
      const emails: EmailMessage[] = [];

      for await (const msg of client.fetch(range, {
        uid: true,
        flags: true,
        source: true
      })) {
        if (!msg.source) continue;
        const parsed: ParsedMail = await simpleParser(msg.source) as ParsedMail;
        emails.push(
          toEmailMessage(msg.uid, parsed, folder, msg.flags)
        );
      }

      // Reverse so newest is first
      emails.reverse();

      return { total, emails };
    } finally {
      mailbox.release();
    }
  });
}

/**
 * Get a single email by UID, including full body.
 */
export async function getEmail(
  folder: string,
  uid: number
): Promise<EmailFull | null> {
  return withClient(async (client) => {
    const mailbox = await client.getMailboxLock(folder, { readOnly: true });
    try {
      let result: EmailFull | null = null;

      const uidStr = String(uid);
      for await (const msg of client.fetch(
        uidStr,
        { uid: true, flags: true, source: true },
        { uid: true }
      )) {
        if (!msg.source) continue;
        const parsed: ParsedMail = await simpleParser(msg.source) as ParsedMail;
        result = toEmailFull(msg.uid, parsed, folder, msg.flags);
      }

      return result;
    } finally {
      mailbox.release();
    }
  });
}

/**
 * Search emails using IMAP SEARCH criteria.
 */
export async function searchEmails(
  folder: string,
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
    since?: string;
    before?: string;
    unseen?: boolean;
    flagged?: boolean;
  },
  limit: number,
  offset: number
): Promise<{ total: number; emails: EmailMessage[] }> {
  return withClient(async (client) => {
    const mailbox = await client.getMailboxLock(folder, { readOnly: true });
    try {
      // Build IMAP search query
      const searchCriteria: Record<string, unknown> = {};

      if (criteria.from) searchCriteria.from = criteria.from.trim();
      if (criteria.to) searchCriteria.to = criteria.to.trim();
      if (criteria.subject) searchCriteria.subject = criteria.subject.trim();
      if (criteria.body) searchCriteria.body = criteria.body.trim();
      if (criteria.since) {
        const d = new Date(criteria.since);
        if (isNaN(d.getTime())) throw new Error(`Invalid 'since' date: "${criteria.since}"`);
        searchCriteria.since = d;
      }
      if (criteria.before) {
        const d = new Date(criteria.before);
        if (isNaN(d.getTime())) throw new Error(`Invalid 'before' date: "${criteria.before}"`);
        searchCriteria.before = d;
      }
      if (criteria.unseen === true) searchCriteria.unseen = true;
      if (criteria.flagged === true) searchCriteria.flagged = true;

      const searchResult = await client.search(searchCriteria, { uid: true });

      // search() can return number[] or false
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) {
        return { total: 0, emails: [] };
      }

      const total = uids.length;

      // Sort UIDs descending (newest first) and apply pagination
      const sortedUids = [...uids].sort((a, b) => b - a);
      const pageUids = sortedUids.slice(offset, offset + limit);

      if (pageUids.length === 0) {
        return { total, emails: [] };
      }

      const emails: EmailMessage[] = [];

      // Convert to UID sequence string for fetch
      const uidSeqStr = pageUids.join(",");
      for await (const msg of client.fetch(
        uidSeqStr,
        { uid: true, flags: true, source: true },
        { uid: true }
      )) {
        if (!msg.source) continue;
        const parsed: ParsedMail = await simpleParser(msg.source) as ParsedMail;
        emails.push(
          toEmailMessage(msg.uid, parsed, folder, msg.flags)
        );
      }

      // Sort by UID descending to maintain newest-first order
      emails.sort((a, b) => b.uid - a.uid);

      return { total, emails };
    } finally {
      mailbox.release();
    }
  });
}
