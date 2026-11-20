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

/**
 * imapflow's messageMove/messageCopy/messageDelete do not throw when the
 * server rejects a command: they log the error and return `false` (or
 * `undefined` when no mailbox is selected). Turn that into an exception so
 * a failed write can never be reported as applied.
 */
function assertSucceeded<T>(response: T | false | undefined, what: string): T {
  if (response === false || response === undefined) {
    throw new Error(`${what} failed on the IMAP server; nothing was reported as changed. Check Proton Bridge and try again.`);
  }
  return response;
}

/**
 * Split requested UIDs into confirmed and unconfirmed using the UIDPLUS
 * map from COPY/MOVE. Without a map (no UIDPLUS), a successful command
 * applies to every UID sent, per RFC 3501/6851.
 */
function confirmed(
  sent: number[],
  response: { uidMap?: Map<number, number> } | boolean
): { applied: number[]; skipped: ActionResult["skipped"] } {
  const uidMap = typeof response === "object" ? response.uidMap : undefined;
  if (!uidMap) return { applied: sent, skipped: [] };
  return {
    applied: sent.filter((uid) => uidMap.has(uid)),
    skipped: sent
      .filter((uid) => !uidMap.has(uid))
      .map((uid) => ({ uid, reason: "server did not confirm this message" }))
  };
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
  // MOVE removes messages from the source, so it needs a read-write SELECT.
  // Verifying UIDs under the same lock is side-effect free (FETCH UID only)
  // and avoids a gap between checking and moving.
  const lock = await client.getMailboxLock(source);
  try {
    const present = await existingUids(client, uids);
    if (present.length === 0) return result(action, source, destination, uids, []);
    const response = assertSucceeded(
      await client.messageMove(present.join(","), destination, { uid: true }),
      action === "trash" ? "Moving to Trash" : "Move"
    );
    const { applied, skipped } = confirmed(present, response);
    return result(action, source, destination, uids, applied, skipped);
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

  // COPY does not modify the source mailbox, so it can run under EXAMINE.
  const lock = await client.getMailboxLock(source, { readOnly: true });
  try {
    const present = await existingUids(client, valid);
    if (present.length === 0) return result("label", source, labelPath, valid, []);
    // COPY into a Labels/* mailbox applies the label; the message stays where it is.
    const response = assertSucceeded(
      await client.messageCopy(present.join(","), labelPath, { uid: true }),
      "Applying the label"
    );
    const { applied, skipped } = confirmed(present, response);
    return result("label", source, labelPath, valid, applied, skipped);
  } finally {
    lock.release();
  }
}

/** What identifies "the same message" across Bridge mailboxes. */
interface Fingerprint {
  messageId: string;
  size: number;
  internalDate: number;
}

function sameMessage(a: Fingerprint, b: Omit<Fingerprint, "messageId">): boolean {
  return a.size === b.size && a.internalDate === b.internalDate;
}

function toTime(date: Date | string | undefined): number {
  return date ? new Date(date).getTime() : NaN;
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

  // 1. Fingerprint the requested messages (read-only).
  const fingerprints = new Map<number, Fingerprint>();
  const present: number[] = [];
  const sourceLock = await client.getMailboxLock(source, { readOnly: true });
  try {
    for await (const msg of client.fetch(
      valid.join(","),
      { uid: true, envelope: true, size: true, internalDate: true },
      { uid: true }
    )) {
      present.push(msg.uid);
      const messageId = msg.envelope?.messageId;
      if (messageId && msg.size !== undefined) {
        fingerprints.set(msg.uid, { messageId, size: msg.size, internalDate: toTime(msg.internalDate) });
      }
    }
  } finally {
    sourceLock.release();
  }

  const skipped: ActionResult["skipped"] = present
    .filter((uid) => !fingerprints.has(uid))
    .map((uid) => ({ uid, reason: "message has no Message-ID header" }));

  // 2. Find exactly one matching copy inside the label mailbox and expunge it there.
  //    UIDs differ per mailbox. Message-ID alone is not unique (a sent copy and the
  //    received copy of the same mail share it), so candidates must also match
  //    size and internal date, and anything ambiguous is skipped rather than guessed.
  const matches = new Map<number, number>(); // source UID -> label UID
  const labelLock = await client.getMailboxLock(labelPath);
  try {
    // Defence in depth: never expunge outside a label mailbox.
    if (!isLabel(labelPath)) {
      throw new Error(`Refusing to remove messages from non-label mailbox '${labelPath}'.`);
    }
    for (const [uid, fp] of fingerprints) {
      const found = await client.search({ header: { "message-id": fp.messageId } }, { uid: true });
      const candidates = Array.isArray(found) ? found : [];
      const exact: number[] = [];
      if (candidates.length > 0) {
        for await (const msg of client.fetch(
          candidates.join(","),
          { uid: true, size: true, internalDate: true },
          { uid: true }
        )) {
          if (sameMessage(fp, { size: msg.size ?? -1, internalDate: toTime(msg.internalDate) })) {
            exact.push(msg.uid);
          }
        }
      }
      if (exact.length === 1) {
        matches.set(uid, exact[0]);
      } else if (exact.length === 0) {
        skipped.push({ uid, reason: `does not have label '${labelPath}'` });
      } else {
        skipped.push({ uid, reason: `ambiguous: ${exact.length} identical copies in '${labelPath}', left unchanged` });
      }
    }
    if (matches.size > 0) {
      assertSucceeded(
        await client.messageDelete([...matches.values()].join(","), { uid: true }),
        "Removing the label"
      );
    }
  } finally {
    labelLock.release();
  }

  const applied = [...matches.keys()].sort((a, b) => a - b);
  return result("unlabel", source, labelPath, valid, applied, skipped);
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
