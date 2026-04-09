export interface EmailMessage {
  uid: number;
  messageId: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string;
  folder: string;
  flags: string[];
  snippet: string;
  hasAttachments: boolean;
}

export interface EmailAddress {
  name: string;
  address: string;
}

export interface EmailFull extends EmailMessage {
  body: string;
  html: string;
  attachments: AttachmentInfo[];
}

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface FolderInfo {
  name: string;
  path: string;
  delimiter: string;
  messageCount: number;
  unseenCount: number;
  flags: string[];
}

export interface PaginatedResult<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
}

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}
