import { z } from "zod";
import { ResponseFormat } from "../types.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";

// ── Shared pagination schema ────────────────────────────────────

const PaginationFields = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe("Maximum emails to return (1–100, default 20)"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip for pagination"),
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' for human-readable or 'json' for structured data")
};

// ── Tool input schemas ──────────────────────────────────────────

export const ListFoldersInputSchema = z
  .object({
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' or 'json'")
  })
  .strict();

export type ListFoldersInput = z.infer<typeof ListFoldersInputSchema>;

/** Folder name must not contain control characters */
const FolderSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/, "Folder name must not contain control characters")
  .default("INBOX");

export const ListEmailsInputSchema = z
  .object({
    folder: FolderSchema
      .describe("Mailbox folder path (e.g., 'INBOX', 'Sent', 'Folders/Partnerships')"),
    ...PaginationFields
  })
  .strict();

export type ListEmailsInput = z.infer<typeof ListEmailsInputSchema>;

export const GetEmailInputSchema = z
  .object({
    folder: FolderSchema
      .describe("Mailbox folder containing the email"),
    uid: z
      .number()
      .int()
      .positive()
      .describe("The IMAP UID of the email to retrieve"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' or 'json'")
  })
  .strict();

export type GetEmailInput = z.infer<typeof GetEmailInputSchema>;

export const SearchEmailsInputSchema = z
  .object({
    folder: FolderSchema
      .describe("Mailbox folder to search in (e.g., 'INBOX', 'Sent')"),
    from: z
      .string()
      .optional()
      .describe("Filter by sender email or name (partial match)"),
    to: z
      .string()
      .optional()
      .describe("Filter by recipient email or name (partial match)"),
    subject: z
      .string()
      .optional()
      .describe("Filter by subject line (partial match)"),
    body: z
      .string()
      .optional()
      .describe("Search within email body text"),
    since: z
      .string()
      .optional()
      .describe("Only emails after this date (ISO 8601, e.g., '2025-01-01')"),
    before: z
      .string()
      .optional()
      .describe("Only emails before this date (ISO 8601, e.g., '2025-04-01')"),
    unseen: z
      .boolean()
      .optional()
      .describe("If true, only return unread emails"),
    flagged: z
      .boolean()
      .optional()
      .describe("If true, only return flagged/starred emails"),
    ...PaginationFields
  })
  .strict();

export type SearchEmailsInput = z.infer<typeof SearchEmailsInputSchema>;
