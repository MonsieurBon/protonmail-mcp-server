import { z } from "zod";
import { ResponseFormat } from "../types.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_BATCH_SIZE } from "../constants.js";

const ResponseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' or 'json'");

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

export const ReadAttachmentInputSchema = z
  .object({
    folder: FolderSchema.describe("Mailbox folder containing the email"),
    uid: z.number().int().positive().describe("The IMAP UID of the email"),
    attachment: z
      .number()
      .int()
      .positive()
      .describe("Attachment number as listed by proton_get_email (1 = first)")
  })
  .strict();

export type ReadAttachmentInput = z.infer<typeof ReadAttachmentInputSchema>;

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

// ── Write tool schemas ──────────────────────────────────────────

const UidsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(MAX_BATCH_SIZE)
  .describe(`IMAP UIDs of the emails in the source folder (1–${MAX_BATCH_SIZE} per call)`);

const SourceFolderSchema = FolderSchema
  .describe("Folder the emails are currently in (the folder their UIDs came from)");

const LabelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/, "Label must not contain control characters")
  .describe("Label name, e.g. 'Important' or 'Labels/Important'. Must already exist.");

export const MoveEmailsInputSchema = z
  .object({
    folder: SourceFolderSchema,
    destination: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/, "Folder name must not contain control characters")
      .describe("Destination: 'INBOX', 'Archive' or a user folder like 'Folders/Receipts'. Must already exist."),
    uids: UidsSchema,
    response_format: ResponseFormatField
  })
  .strict();

export type MoveEmailsInput = z.infer<typeof MoveEmailsInputSchema>;

export const TrashEmailsInputSchema = z
  .object({
    folder: SourceFolderSchema,
    uids: UidsSchema,
    response_format: ResponseFormatField
  })
  .strict();

export type TrashEmailsInput = z.infer<typeof TrashEmailsInputSchema>;

export const LabelEmailsInputSchema = z
  .object({
    folder: SourceFolderSchema,
    label: LabelSchema,
    uids: UidsSchema,
    response_format: ResponseFormatField
  })
  .strict();

export type LabelEmailsInput = z.infer<typeof LabelEmailsInputSchema>;
