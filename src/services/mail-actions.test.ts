import { describe, it, expect, beforeEach } from "vitest";
import {
  moveEmailsWith,
  trashEmailsWith,
  labelEmailsWith,
  unlabelEmailsWith,
  validateUids,
  type MailClient
} from "./mail-actions.js";
import { FolderPolicyError, toLabelPath, normalizeFolder } from "./folder-policy.js";

interface FakeMessage {
  uid: number;
  messageId?: string;
}

type Call =
  | { op: "lock"; path: string; readOnly: boolean }
  | { op: "move"; from: string; range: string; to: string }
  | { op: "copy"; from: string; range: string; to: string }
  | { op: "expunge"; from: string; range: string };

/** Minimal in-memory stand-in for ImapFlow that records every write. */
class FakeImap {
  selected: string | null = null;
  calls: Call[] = [];

  constructor(public mailboxes: Record<string, FakeMessage[]>) {}

  private uids(range: string): number[] {
    return range.split(",").map(Number);
  }

  private current(): FakeMessage[] {
    if (!this.selected) throw new Error("no mailbox selected");
    return this.mailboxes[this.selected];
  }

  async status(path: string) {
    if (!(path in this.mailboxes)) throw new Error("NO [NONEXISTENT]");
    return { path, messages: this.mailboxes[path].length };
  }

  async getMailboxLock(path: string, opts?: { readOnly?: boolean }) {
    if (!(path in this.mailboxes)) throw new Error("Mailbox not found");
    this.selected = path;
    this.calls.push({ op: "lock", path, readOnly: !!opts?.readOnly });
    return { path, release: () => { this.selected = null; } };
  }

  async *fetch(range: string) {
    const wanted = new Set(this.uids(range));
    for (const m of this.current().filter((m) => wanted.has(m.uid))) {
      yield { uid: m.uid, envelope: { messageId: m.messageId } };
    }
  }

  async search(query: { header: Record<string, string> }) {
    const id = query.header["message-id"];
    return this.current().filter((m) => m.messageId === id).map((m) => m.uid);
  }

  async messageMove(range: string, to: string) {
    this.calls.push({ op: "move", from: this.selected!, range, to });
    return true;
  }

  async messageCopy(range: string, to: string) {
    this.calls.push({ op: "copy", from: this.selected!, range, to });
    return true;
  }

  async messageDelete(range: string) {
    this.calls.push({ op: "expunge", from: this.selected!, range });
    return true;
  }

  writes() {
    return this.calls.filter((c) => c.op !== "lock");
  }
}

let imap: FakeImap;
let client: MailClient;

beforeEach(() => {
  imap = new FakeImap({
    INBOX: [
      { uid: 10, messageId: "<a@x>" },
      { uid: 11, messageId: "<b@x>" },
      { uid: 12 } // no Message-ID
    ],
    Archive: [],
    Sent: [{ uid: 5, messageId: "<s@x>" }],
    Trash: [{ uid: 1, messageId: "<t@x>" }],
    Spam: [{ uid: 2, messageId: "<p@x>" }],
    "All Mail": [],
    "Folders/Receipts": [],
    "Labels/Important": [{ uid: 900, messageId: "<a@x>" }]
  });
  client = imap as unknown as MailClient;
});

describe("validateUids", () => {
  it("dedupes and sorts", () => {
    expect(validateUids([3, 1, 3])).toEqual([1, 3]);
  });
  it("rejects empty, invalid and oversized batches", () => {
    expect(() => validateUids([])).toThrow();
    expect(() => validateUids([0])).toThrow();
    expect(() => validateUids([1.5])).toThrow();
    expect(() => validateUids(Array.from({ length: 51 }, (_, i) => i + 1))).toThrow(/limit is 50/);
  });
  it("allows exactly 50", () => {
    expect(validateUids(Array.from({ length: 50 }, (_, i) => i + 1))).toHaveLength(50);
  });
});

describe("folder policy helpers", () => {
  it("normalizes INBOX case-insensitively only", () => {
    expect(normalizeFolder(" inbox ")).toBe("INBOX");
    expect(normalizeFolder("archive")).toBe("archive");
  });
  it("builds label paths", () => {
    expect(toLabelPath("Important")).toBe("Labels/Important");
    expect(toLabelPath("Labels/Important")).toBe("Labels/Important");
    expect(() => toLabelPath("Labels/")).toThrow(FolderPolicyError);
  });
});

describe("moveEmailsWith", () => {
  it("moves existing messages and reports missing ones", async () => {
    const r = await moveEmailsWith(client, "inbox", "Folders/Receipts", [11, 10, 99]);
    expect(r.applied).toEqual([10, 11]);
    expect(r.notFound).toEqual([99]);
    expect(imap.writes()).toEqual([{ op: "move", from: "INBOX", range: "10,11", to: "Folders/Receipts" }]);
  });

  it("does nothing when no UID exists", async () => {
    const r = await moveEmailsWith(client, "INBOX", "Archive", [99]);
    expect(r.applied).toEqual([]);
    expect(imap.writes()).toEqual([]);
  });

  it.each(["Trash", "Spam"])("refuses to move out of %s", async (src) => {
    await expect(moveEmailsWith(client, src, "INBOX", [1])).rejects.toThrow(FolderPolicyError);
    expect(imap.writes()).toEqual([]);
  });

  it.each(["All Mail", "Labels/Important", "Drafts"])("refuses source %s", async (src) => {
    await expect(moveEmailsWith(client, src, "Archive", [1])).rejects.toThrow(FolderPolicyError);
  });

  it.each(["Trash", "Spam", "Sent", "Labels/Important", "All Mail"])(
    "refuses destination %s",
    async (dest) => {
      await expect(moveEmailsWith(client, "INBOX", dest, [10])).rejects.toThrow(FolderPolicyError);
      expect(imap.writes()).toEqual([]);
    }
  );

  it("refuses a destination that does not exist", async () => {
    await expect(moveEmailsWith(client, "INBOX", "Folders/Nope", [10])).rejects.toThrow(/does not exist/);
    expect(imap.writes()).toEqual([]);
  });

  it("refuses identical source and destination", async () => {
    await expect(moveEmailsWith(client, "INBOX", "inbox", [10])).rejects.toThrow(/both/);
  });
});

describe("trashEmailsWith", () => {
  it("moves to Trash, never expunges", async () => {
    const r = await trashEmailsWith(client, "Sent", [5]);
    expect(r.applied).toEqual([5]);
    expect(imap.writes()).toEqual([{ op: "move", from: "Sent", range: "5", to: "Trash" }]);
  });

  it.each(["Trash", "Spam", "All Mail", "Labels/Important"])("refuses source %s", async (src) => {
    await expect(trashEmailsWith(client, src, [1])).rejects.toThrow(FolderPolicyError);
    expect(imap.writes()).toEqual([]);
  });
});

describe("labelEmailsWith", () => {
  it("copies into the label mailbox and leaves the source alone", async () => {
    const r = await labelEmailsWith(client, "INBOX", "Important", [11, 12]);
    expect(r.applied).toEqual([11, 12]);
    expect(imap.writes()).toEqual([{ op: "copy", from: "INBOX", range: "11,12", to: "Labels/Important" }]);
  });

  it("refuses a label that does not exist", async () => {
    await expect(labelEmailsWith(client, "INBOX", "Nope", [10])).rejects.toThrow(/does not exist/);
  });

  it.each(["Trash", "Spam"])("refuses to label messages in %s", async (src) => {
    await expect(labelEmailsWith(client, src, "Important", [1])).rejects.toThrow(FolderPolicyError);
  });
});

describe("unlabelEmailsWith", () => {
  it("expunges only inside the label mailbox, matched by Message-ID", async () => {
    const r = await unlabelEmailsWith(client, "INBOX", "Important", [10, 11, 12, 99]);
    expect(r.applied).toEqual([10]);
    expect(r.notFound).toEqual([99]);
    expect(r.skipped).toEqual([
      { uid: 12, reason: "message has no Message-ID header" },
      { uid: 11, reason: "does not have label 'Labels/Important'" }
    ]);
    expect(imap.writes()).toEqual([{ op: "expunge", from: "Labels/Important", range: "900" }]);
  });

  it("reads the source folder read-only", async () => {
    await unlabelEmailsWith(client, "INBOX", "Important", [10]);
    expect(imap.calls[0]).toEqual({ op: "lock", path: "INBOX", readOnly: true });
  });

  it("never expunges when nothing matches", async () => {
    await unlabelEmailsWith(client, "INBOX", "Important", [11]);
    expect(imap.writes()).toEqual([]);
  });
});

describe("no write ever touches Trash/Spam contents or expunges outside Labels/", () => {
  it("holds across all operations", async () => {
    await moveEmailsWith(client, "INBOX", "Archive", [10]);
    await trashEmailsWith(client, "INBOX", [11]);
    await labelEmailsWith(client, "Sent", "Important", [5]);
    await unlabelEmailsWith(client, "INBOX", "Important", [10]);
    for (const w of imap.writes()) {
      expect(["Trash", "Spam"]).not.toContain(w.from);
      if (w.op === "expunge") expect(w.from.startsWith("Labels/")).toBe(true);
    }
  });
});
