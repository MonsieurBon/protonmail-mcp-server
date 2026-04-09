# protonmail-mcp-server

A Model Context Protocol (MCP) server for Proton Mail — read-only email access through Proton Bridge.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

Connect Claude (or any MCP client) to your Proton Mail so it can search, list, and read your email — without your email ever leaving your machine.

## Features

- **List folders** with message and unread counts
- **List emails** with pagination, sorted newest first
- **Search emails** by sender, recipient, subject, body text, date range, read/flagged status
- **Read full email content** by IMAP UID, including attachment metadata
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

## Privacy & Security

- **Read-only** — all four tools are read-only; no email modification, deletion, or sending
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

All operations are **read-only** — the assistant cannot send, delete, or modify your emails.

## Development

```bash
npm run dev    # Watch mode with auto-reload
npm run build  # Production build
npm start      # Run built server
```

## License

[MIT](LICENSE)
