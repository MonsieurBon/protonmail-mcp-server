/**
 * Folder policy for write operations.
 *
 * Proton Bridge exposes Proton's mailbox model over IMAP like this:
 *   - System folders: INBOX, Drafts, Sent, Starred, Archive, Spam, Trash, All Mail
 *   - User folders:   Folders/<name>
 *   - Labels:         Labels/<name>  (virtual mailboxes; a message "in" Labels/X carries label X)
 *
 * The rules below decide which folders each write tool may touch. They are
 * deliberately conservative: anything not explicitly allowed is refused.
 */

export const LABEL_PREFIX = "Labels/";
export const FOLDER_PREFIX = "Folders/";

export const TRASH = "Trash";
export const SPAM = "Spam";

/** Folders that write tools must never take messages out of. */
const PROTECTED_SOURCES = new Set([TRASH, SPAM]);

/** System folders messages may be moved or trashed out of. */
const MOVABLE_SYSTEM_SOURCES = new Set(["INBOX", "Archive", "Sent"]);

/** System folders messages may be moved into (Trash goes through proton_trash_emails). */
const MOVE_SYSTEM_DESTINATIONS = new Set(["INBOX", "Archive"]);

/** IMAP treats INBOX case-insensitively; everything else is case-sensitive. */
export function normalizeFolder(path: string): string {
  const trimmed = path.trim();
  return trimmed.toUpperCase() === "INBOX" ? "INBOX" : trimmed;
}

function hasName(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && path.length > prefix.length;
}

export function isLabel(path: string): boolean {
  return hasName(normalizeFolder(path), LABEL_PREFIX);
}

export function isUserFolder(path: string): boolean {
  return hasName(normalizeFolder(path), FOLDER_PREFIX);
}

export class FolderPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderPolicyError";
  }
}

function assertNotProtectedSource(source: string, action: string): void {
  if (PROTECTED_SOURCES.has(source)) {
    throw new FolderPolicyError(
      `Refusing to ${action} messages in '${source}'. Messages in Trash and Spam can only be handled in Proton Mail directly.`
    );
  }
}

/** Source folder for proton_move_emails and proton_trash_emails. */
export function assertMovableSource(folder: string, action: string): string {
  const source = normalizeFolder(folder);
  assertNotProtectedSource(source, action);
  if (MOVABLE_SYSTEM_SOURCES.has(source) || isUserFolder(source)) return source;
  throw new FolderPolicyError(
    `Cannot ${action} messages out of '${source}'. Allowed: INBOX, Archive, Sent and folders under '${FOLDER_PREFIX}'.`
  );
}

/** Destination folder for proton_move_emails. */
export function assertMoveDestination(folder: string): string {
  const destination = normalizeFolder(folder);
  if (destination === TRASH) {
    throw new FolderPolicyError("Use proton_trash_emails to move messages to Trash.");
  }
  if (MOVE_SYSTEM_DESTINATIONS.has(destination) || isUserFolder(destination)) return destination;
  throw new FolderPolicyError(
    `Cannot move messages to '${destination}'. Allowed: INBOX, Archive and folders under '${FOLDER_PREFIX}'. Use proton_label_emails for labels.`
  );
}

/** Source folder for proton_label_emails and proton_unlabel_emails. */
export function assertLabelSource(folder: string, action: string): string {
  const source = normalizeFolder(folder);
  assertNotProtectedSource(source, action);
  return source;
}

/** Turns 'Important' or 'Labels/Important' into 'Labels/Important'. */
export function toLabelPath(label: string): string {
  const trimmed = label.trim();
  const path = trimmed.startsWith(LABEL_PREFIX) ? trimmed : `${LABEL_PREFIX}${trimmed}`;
  if (!isLabel(path)) {
    throw new FolderPolicyError(`Invalid label '${label}'.`);
  }
  return path;
}
