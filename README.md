# protonmail-mcp-server

A Model Context Protocol (MCP) server for Proton Mail — read and organize email through Proton Bridge. **It cannot send email and cannot permanently delete email.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

> Fork of [de-Blanck/protonmail-mcp-server](https://github.com/de-Blanck/protonmail-mcp-server), adding tools to organize email (move, label, trash) while keeping sending impossible.

Connect Claude (or any MCP client) to your Proton Mail so it can search, list, read, move, label, and trash your email — without your email ever leaving your machine.

## Features

- **List folders** with message and unread counts
- **List emails** with pagination, sorted newest first
- **Search emails** by sender, recipient, subject, body text, date range, read/flagged status
- **Read full email content** by IMAP UID, including attachment metadata
- **Move emails** between INBOX, Archive and your folders
- **Label and unlabel emails** with your existing Proton labels
- **Trash emails** (recoverable — there is no permanent delete)
- **No sending** — there is no SMTP code in this server at all
- **Markdown and JSON** response formats
- **Input validation** via Zod schemas
- **Connection timeouts** to prevent resource exhaustion

## Prerequisites

- **Node.js 18+**
- **Proton Bridge** running on your machine with IMAP enabled
- Your **Bridge-specific IMAP credentials** (not your Proton account password)

### Finding your Bridge credentials

1. Open Proton Bridge
2. Click your account name
3. Go to **IMAP/SMTP settings** (or **Mailbox details**)
4. Note the **Username** (your email) and **Password** (Bridge-generated)
5. Note the **IMAP port** (default: 1143)

## Installation

```bash
npm install
npm run build
```

Or install globally from npm:

```bash
npm install -g protonmail-mcp-server
```

## Configuration

Set these environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROTON_BRIDGE_USER` | Yes | — | Bridge IMAP username (your email) |
| `PROTON_BRIDGE_PASSWORD` | Yes | — | Bridge-generated IMAP password |
| `PROTON_BRIDGE_HOST` | No | `127.0.0.1` | Bridge host |
| `PROTON_BRIDGE_PORT` | No | `1143` | Bridge IMAP port |

> **Security:** Configuration files containing your Bridge password are plaintext. Never commit them to version control or share them.

## Adding to Claude Code

Add to your Claude Code MCP config (`~/.claude/config.json` or project-level):

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "node",
      "args": ["/path/to/protonmail-mcp-server/dist/index.js"],
      "env": {
        "PROTON_BRIDGE_USER": "your-email@proton.me",
        "PROTON_BRIDGE_PASSWORD": "your-bridge-password"
      }
    }
  }
}
```

## Adding to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "node",
      "args": ["/path/to/protonmail-mcp-server/dist/index.js"],
      "env": {
        "PROTON_BRIDGE_USER": "your-email@proton.me",
        "PROTON_BRIDGE_PASSWORD": "your-bridge-password"
      }
    }
  }
}
```

## Available tools

### `proton_list_folders`
List all mailbox folders with message and unread counts.

### `proton_list_emails`
List emails in a folder (newest first) with pagination.

### `proton_get_email`
Read a single email's full content by IMAP UID.

### `proton_search_emails`
Search emails by sender, recipient, subject, body text, date range, read/flagged status.

### Write tools

All write tools take a source `folder` and the `uids` of emails in that folder (max 50 per call). They never create folders or labels, and never touch emails in Trash or Spam.

| Tool | What it does | Allowed source | Allowed target |
|---|---|---|---|
| `proton_move_emails` | Moves emails | INBOX, Archive, Sent, `Folders/*` | INBOX, Archive, `Folders/*` |
| `proton_trash_emails` | Moves emails to Trash (recoverable) | INBOX, Archive, Sent, `Folders/*` | Trash |
| `proton_label_emails` | Adds a label; the email stays where it is | any except Trash/Spam | `Labels/*` |
| `proton_unlabel_emails` | Removes a label; the email is not moved or deleted | any except Trash/Spam | `Labels/*` |

How these map onto Proton Bridge's IMAP model: labelling is a `COPY` into `Labels/<name>`; unlabelling finds the email inside `Labels/<name>` by Message-ID and expunges it *from that label mailbox only*, which Bridge interprets as removing the label. That is the only `EXPUNGE` the server ever issues.

`proton_trash_emails` is annotated `destructiveHint: true`, so MCP clients that support it can ask for confirmation before running it.

## Privacy & Security

- **No sending** — no SMTP client, no send tool
- **No permanent deletion** — deleting means moving to Trash; emails in Trash and Spam are never touched
- **Read tools open mailboxes read-only** (`EXAMINE`), so reading can never change anything
- **Bounded writes** — at most 50 emails per call; folders and labels are never created
- **Policy checks before connecting** — a refused request never opens an IMAP session
- **Localhost-only by default** — connects to Proton Bridge on `127.0.0.1`; TLS certificate validation is enforced for non-localhost connections
- **No disk caching** — opens a fresh IMAP connection per request, no email data is stored on disk
- **No credential logging** — your Bridge password is never logged, printed, or exposed in error messages
- **Input validation** — all inputs are validated with Zod schemas; folder names are sanitized against control characters
- **Connection timeouts** — all IMAP connections have configurable timeouts to prevent resource exhaustion

## LLM Integration

This server implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), making it compatible with any MCP client. When connected to an AI assistant like Claude, the assistant can:

- Check for new or unread emails
- Search for specific emails by sender, subject, or date
- Read and summarize email content
- Answer questions about your email (e.g., "What did Alice say about the quarterly report?")
- List your mailbox folders and their message counts
- Archive, file, label, and trash emails

The assistant **cannot send email** and **cannot permanently delete email**: trashed emails stay recoverable in Proton Mail until you empty Trash yourself.

> Emails can contain text written to manipulate an AI assistant (prompt injection). With write tools enabled, a malicious email could try to get the assistant to trash or move other emails. The Trash-only delete and the 50-email limit keep that recoverable, but consider having your client confirm write tool calls.

## Development

```bash
npm run dev    # Watch mode with auto-reload
npm run build  # Production build
npm start      # Run built server
```

## License

[MIT](LICENSE)
