# Security Policy

Misgeret processes sensitive financial information locally. Security reports must protect the people whose data could be affected.

## Supported versions

Only the latest published release receives security fixes.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/OrMizrahi12/misgeret/security/advisories/new). Do not open a public issue for an unpatched vulnerability.

Include:

- affected version and operating system;
- a minimal reproduction using synthetic data;
- expected security impact and trust boundary;
- relevant code paths or a proof of concept that contains no real credentials or financial records.

Never attach real credentials, transaction exports, SQLite databases, backups, logs, screenshots with personal data, encryption keys, tokens, or institution session material.

If private reporting is unavailable, contact the maintainer without attaching sensitive material and request a private channel.

## Scope priorities

High-priority areas include credential encryption, safeStorage/keyring handling, loopback API authorization, privileged IPC, update integrity, backup/restore, profile isolation, path traversal, scraper data normalization, and release artifact contents.

Security fixes may be released without advance notice. After a fix is available, the project may publish a redacted advisory that does not expose user data.
