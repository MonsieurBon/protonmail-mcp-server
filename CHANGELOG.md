# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-09

### Added
- Initial public release
- List mailbox folders with message/unread counts
- List emails with pagination (newest first)
- Search emails by sender, recipient, subject, body, date range, read/flagged status
- Read full email content by UID
- Markdown and JSON response formats
- Per-request connections with automatic cleanup
- Input validation via Zod schemas

### Security
- TLS certificate validation enforced for non-localhost connections
- IMAP folder name sanitization against control characters
- Connection timeouts to prevent resource exhaustion
- No credential logging, no disk caching of email content
