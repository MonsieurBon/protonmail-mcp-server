/**
 * Write operations: move, label, unlabel and trash.
 *
 * There is intentionally no way to send mail and no permanent delete:
 *   - "Trash" is a MOVE to the Trash folder, recoverable in Proton Mail.
 *   - The only EXPUNGE issued anywhere is inside a Labels/* mailbox, where
 *     Proton Bridge interprets it as "remove this label", not "delete".
 */

import type { ImapFlow } from "imapflow";
import { MAX_BATCH_SIZE } from "../constants.js";
import {
  TRASH,
  isLabel,
  assertMovableSource,
  assertMoveDestination,
  assertLabelSource,
  toLabelPath
} from "./folder-policy.js";
import { withClient } from "./imap-client.js";

export interface ActionResult {
  action: "move" | "label" | "unlabel" | "trash";
  source: string;
  target: string;
  /** UIDs (in the source folder) the action was applied to */
  applied: number[];
  /** Requested UIDs that do not exist in the source folder */
  notFound: number[];
  /** Messages skipped for another reason, with the reason */
  skipped: Array<{ uid: number; reason: string }>;
}

/** The subset of ImapFlow used here, so tests can supply a fake. */
export type MailClient = Pick<
  ImapFlow,
  "getMailboxLock" | "fetch" | "messageMove" | "messageCopy" | "messageDelete" | "search" | "status"
>;

export function validateUids(uids: number[]): number[] {
  const unique = [...new Set(uids)];
  if (unique.length === 0) {
    throw new Error("No UIDs given.");
  }
  if (unique.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Too many emails in one call (${unique.length}). The limit is ${MAX_BATCH_SIZE}; split the request into smaller batches.`
    );
  }
  for (const uid of unique) {
    if (!Number.isInteger(uid) || uid < 1) {
      throw new Error(`Invalid UID: ${uid}`);
    }
  }
  return unique.sort((a, b) => a - b);
}

/** Throws a clear error if the mailbox does not exist. Never creates one. */
async function assertMailboxExists(client: MailClient, path: string): Promise<void> {
  try {
    await client.status(path, { messages: true });
  } catch {
    throw new Error(
      `Folder or label '${path}' does not exist. Create it in Proton Mail first; this server never creates folders or labels.`
    );
  }
}

/** Returns the requested UIDs that actually exist in the currently selected mailbox. */
async function existingUids(client: MailClient, uids: number[]): Promise<number[]> {
  const found: number[] = [];
  for await (const msg of client.fetch(uids.join(","), { uid: true }, { uid: true })) {
    found.push(msg.uid);
  }
  return found.sort((a, b) => a - b);
}

function result(
  action: ActionResult["action"],
  source: string,
  target: string,
  requested: number[],
  applied: number[],
  skipped: ActionResult["skipped"] = []
): ActionResult {
  const handled = new Set([...applied, ...skipped.map((s) => s.uid)]);
  return {
    action,
    source,
    target,
    applied,
    notFound: requested.filter((uid) => !handled.has(uid)),
    skipped
  };
}

async function moveInternal(
  client: MailClient,
  action: "move" | "trash",
  source: string,
  destination: string,
  uids: number[]
): Promise<ActionResult> {
  await assertMailboxExists(client, destination);
  const lock = await client.getMailboxLock(source);
  try {
    const present = await existingUids(client, uids);
    if (present.length > 0) {
      await client.messageMove(present.join(","), destination, { uid: true });
    }
    return result(action, source, destination, uids, present);
  } finally {
    lock.release();
  }
}

export async function moveEmailsWith(
  client: MailClient,
  folder: string,
  destination: string,
  uids: number[]
): Promise<ActionResult> {
  const source = assertMovableSource(folder, "move");
  const target = assertMoveDestination(destination);
  if (source === target) {
    throw new Error(`Source and destination are both '${source}'.`);
  }
  return moveInternal(client, "move", source, target, validateUids(uids));
}

export async function trashEmailsWith(
  client: MailClient,
  folder: string,
  uids: number[]
): Promise<ActionResult> {
  const source = assertMovableSource(folder, "trash");
  return moveInternal(client, "trash", source, TRASH, validateUids(uids));
}

export async function labelEmailsWith(
  client: MailClient,
  folder: string,
  label: string,
  uids: number[]
): Promise<ActionResult> {
  const source = assertLabelSource(folder, "label");
  const labelPath = toLabelPath(label);
  const valid = validateUids(uids);
  await assertMailboxExists(client, labelPath);

  const lock = await client.getMailboxLock(source);
  try {
    const present = await existingUids(client, valid);
    if (present.length > 0) {
      // COPY into a Labels/* mailbox applies the label; the message stays where it is.
      await client.messageCopy(present.join(","), labelPath, { uid: true });
    }
    return result("label", source, labelPath, valid, present);
  } finally {
    lock.release();
  }
}

export async function unlabelEmailsWith(
  client: MailClient,
  folder: string,
  label: string,
  uids: number[]
): Promise<ActionResult> {
  const source = assertLabelSource(folder, "unlabel");
  const labelPath = toLabelPath(label);
  const valid = validateUids(uids);
  await assertMailboxExists(client, labelPath);

  // 1. Read the Message-IDs of the requested messages (read-only).
  const messageIds = new Map<number, string>();
  const present: number[] = [];
  const sourceLock = await client.getMailboxLock(source, { readOnly: true });
  try {
    for await (const msg of client.fetch(valid.join(","), { uid: true, envelope: true }, { uid: true })) {
      present.push(msg.uid);
      const id = msg.envelope?.messageId;
      if (id) messageIds.set(msg.uid, id);
    }
  } finally {
    sourceLock.release();
  }

  const skipped: ActionResult["skipped"] = present
    .filter((uid) => !messageIds.has(uid))
    .map((uid) => ({ uid, reason: "message has no Message-ID header" }));

  // 2. Find the same messages inside the label mailbox and expunge them there.
  //    UIDs differ per mailbox, so the match is by Message-ID.
  const applied: number[] = [];
  const labelLock = await client.getMailboxLock(labelPath);
  try {
    // Defence in depth: never expunge outside a label mailbox.
    if (!isLabel(labelPath)) {
      throw new Error(`Refusing to remove messages from non-label mailbox '${labelPath}'.`);
    }
    const labelUids: number[] = [];
    for (const [uid, messageId] of messageIds) {
      const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
      if (Array.isArray(found) && found.length > 0) {
        labelUids.push(...found);
        applied.push(uid);
      } else {
        skipped.push({ uid, reason: `does not have label '${labelPath}'` });
      }
    }
    if (labelUids.length > 0) {
      await client.messageDelete([...new Set(labelUids)].join(","), { uid: true });
    }
  } finally {
    labelLock.release();
  }

  return result("unlabel", source, labelPath, valid, applied.sort((a, b) => a - b), skipped);
}

// ── Connection-managing wrappers used by the MCP tools ──────────
// Policy and input checks run before connecting, so a refused request
// never opens an IMAP session at all.

export async function moveEmails(folder: string, destination: string, uids: number[]) {
  const source = assertMovableSource(folder, "move");
  const target = assertMoveDestination(destination);
  validateUids(uids);
  if (source === target) throw new Error(`Source and destination are both '${source}'.`);
  return withClient((c) => moveEmailsWith(c, folder, destination, uids));
}

export async function trashEmails(folder: string, uids: number[]) {
  assertMovableSource(folder, "trash");
  validateUids(uids);
  return withClient((c) => trashEmailsWith(c, folder, uids));
}

export async function labelEmails(folder: string, label: string, uids: number[]) {
  assertLabelSource(folder, "label");
  toLabelPath(label);
  validateUids(uids);
  return withClient((c) => labelEmailsWith(c, folder, label, uids));
}

export async function unlabelEmails(folder: string, label: string, uids: number[]) {
  assertLabelSource(folder, "unlabel");
  toLabelPath(label);
  validateUids(uids);
  return withClient((c) => unlabelEmailsWith(c, folder, label, uids));
}
