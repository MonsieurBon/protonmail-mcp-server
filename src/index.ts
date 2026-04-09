#!/usr/bin/env node
/**
 * Proton Mail MCP Server
 *
 * Connects to Proton Bridge via IMAP to provide read-only email access
 * through the Model Context Protocol. Designed to run locally alongside
 * Proton Bridge on the user's machine.
 *
 * Environment variables:
 *   PROTON_BRIDGE_USER     — Bridge IMAP username (required)
 *   PROTON_BRIDGE_PASSWORD — Bridge IMAP password (required)
 *   PROTON_BRIDGE_HOST     — Bridge host (default: 127.0.0.1)
 *   PROTON_BRIDGE_PORT     — Bridge IMAP port (default: 1143)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  ListFoldersInputSchema,
  ListEmailsInputSchema,
  GetEmailInputSchema,
  SearchEmailsInputSchema
} from "./schemas/tools.js";
import type {
  ListFoldersInput,
  ListEmailsInput,
  GetEmailInput,
  SearchEmailsInput
} from "./schemas/tools.js";
import {
  listFolders,
  listEmails,
  getEmail,
  searchEmails
} from "./services/imap-client.js";
import {
  formatFolders,
  formatEmailList,
  formatEmailFull
} from "./tools/formatters.js";
import type { PaginatedResult, EmailMessage } from "./types.js";

// ── Server instance ─────────────────────────────────────────────

const server = new McpServer({
  name: "protonmail-mcp-server",
  version: "1.0.0"
});

// ── Error handler ───────────────────────────────────────────────

function handleError(error: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const message =
    error instanceof Error ? error.message : String(error);

  let hint = "";
  if (message.includes("ECONNREFUSED")) {
    hint =
      " Proton Bridge does not appear to be running. Start Proton Bridge and try again.";
  } else if (
    message.includes("AUTHENTICATIONFAILED") ||
    message.includes("Invalid credentials")
  ) {
    hint =
      " Check your PROTON_BRIDGE_USER and PROTON_BRIDGE_PASSWORD environment variables. " +
      "Use the Bridge-specific password from Proton Bridge > Account > IMAP/SMTP settings, " +
      "not your Proton account password.";
  } else if (message.includes("Mailbox not found") || message.includes("NO [NONEXISTENT]")) {
    hint = " The specified folder does not exist. Use proton_list_folders to see available folders.";
  }

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Error: ${message}${hint}`
      }
    ]
  };
}

// ── Tool: proton_list_folders ───────────────────────────────────

server.registerTool(
  "proton_list_folders",
  {
    title: "List Proton Mail Folders",
    description: `List all mailbox folders in the Proton Mail account with message counts and unread counts.

Use this tool to discover available folders before listing or searching emails.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  A list of folders with path, message count, and unread count.

Examples:
  - "What folders do I have?" -> proton_list_folders()
  - "How many unread emails do I have?" -> proton_list_folders()`,
    inputSchema: ListFoldersInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params: ListFoldersInput) => {
    try {
      const folders = await listFolders();
      return {
        content: [
          {
            type: "text" as const,
            text: formatFolders(folders, params.response_format)
          }
        ]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// ── Tool: proton_list_emails ────────────────────────────────────

server.registerTool(
  "proton_list_emails",
  {
    title: "List Proton Mail Emails",
    description: `List emails in a folder, sorted newest first, with pagination support.

Returns email summaries (subject, from, date, snippet) — not full bodies. Use proton_get_email to read an individual email's full content.

Args:
  - folder (string): Mailbox folder path (default: 'INBOX')
  - limit (number): Maximum emails to return, 1–100 (default: 20)
  - offset (number): Skip this many emails for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Paginated list of email summaries with total count and pagination metadata.

Examples:
  - "Show my latest emails" -> proton_list_emails({ folder: "INBOX" })
  - "What's in my Sent folder?" -> proton_list_emails({ folder: "Sent" })
  - "Show me the next page" -> proton_list_emails({ folder: "INBOX", offset: 20 })`,
    inputSchema: ListEmailsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params: ListEmailsInput) => {
    try {
      const { total, emails } = await listEmails(
        params.folder,
        params.limit,
        params.offset
      );

      const result: PaginatedResult<EmailMessage> = {
        total,
        count: emails.length,
        offset: params.offset,
        items: emails,
        has_more: total > params.offset + emails.length,
        ...(total > params.offset + emails.length
          ? { next_offset: params.offset + emails.length }
          : {})
      };

      return {
        content: [
          {
            type: "text" as const,
            text: formatEmailList(result, params.folder, params.response_format)
          }
        ]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// ── Tool: proton_get_email ──────────────────────────────────────

server.registerTool(
  "proton_get_email",
  {
    title: "Get Proton Mail Email",
    description: `Retrieve a single email's full content by its IMAP UID, including body text and attachment metadata.

Use proton_list_emails or proton_search_emails first to find the UID of the email you want to read.

Args:
  - folder (string): The folder containing the email (default: 'INBOX')
  - uid (number): The IMAP UID of the email
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Full email with headers, body text, and attachment list. Does NOT return attachment binary data.

Examples:
  - "Read email 1234" -> proton_get_email({ folder: "INBOX", uid: 1234 })
  - "Show me that email from Alice" -> first search, then get by UID`,
    inputSchema: GetEmailInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params: GetEmailInput) => {
    try {
      const email = await getEmail(params.folder, params.uid);

      if (!email) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No email found with UID ${params.uid} in folder '${params.folder}'. Check the UID and folder are correct.`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatEmailFull(email, params.response_format)
          }
        ]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// ── Tool: proton_search_emails ──────────────────────────────────

server.registerTool(
  "proton_search_emails",
  {
    title: "Search Proton Mail Emails",
    description: `Search emails in a folder using IMAP search criteria. Supports filtering by sender, recipient, subject, body text, date range, and read/flagged status.

Returns email summaries — use proton_get_email to read the full content of a specific result.

Args:
  - folder (string): Folder to search in (default: 'INBOX')
  - from (string, optional): Filter by sender email or name
  - to (string, optional): Filter by recipient email or name
  - subject (string, optional): Filter by subject text
  - body (string, optional): Search within email body
  - since (string, optional): Emails after this date (ISO 8601, e.g., '2025-01-01')
  - before (string, optional): Emails before this date (ISO 8601)
  - unseen (boolean, optional): Only unread emails
  - flagged (boolean, optional): Only starred/flagged emails
  - limit (number): Max results, 1–100 (default: 20)
  - offset (number): Pagination offset (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Paginated list of matching email summaries.

Examples:
  - "Find emails from Alice" -> proton_search_emails({ from: "Alice" })
  - "Unread emails about quarterly report" -> proton_search_emails({ subject: "quarterly report", unseen: true })
  - "Emails from acme.com in March" -> proton_search_emails({ from: "acme.com", since: "2025-03-01", before: "2025-04-01" })`,
    inputSchema: SearchEmailsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params: SearchEmailsInput) => {
    try {
      const { total, emails } = await searchEmails(
        params.folder,
        {
          from: params.from,
          to: params.to,
          subject: params.subject,
          body: params.body,
          since: params.since,
          before: params.before,
          unseen: params.unseen,
          flagged: params.flagged
        },
        params.limit,
        params.offset
      );

      const result: PaginatedResult<EmailMessage> = {
        total,
        count: emails.length,
        offset: params.offset,
        items: emails,
        has_more: total > params.offset + emails.length,
        ...(total > params.offset + emails.length
          ? { next_offset: params.offset + emails.length }
          : {})
      };

      return {
        content: [
          {
            type: "text" as const,
            text: formatEmailList(result, params.folder, params.response_format)
          }
        ]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// ── Start server ────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("protonmail-mcp-server running via stdio");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Fatal error:", message);
  process.exit(1);
});
