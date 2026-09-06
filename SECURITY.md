# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x   | ✅ Latest  |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via [GitHub Security Advisories](https://github.com/codefuturist/email-mcp/security/advisories/new).

You should receive a response within 48 hours. If the issue is confirmed, a fix will be released as soon as possible.

## Security Considerations

email-mcp handles sensitive email credentials and message content. The project includes several security measures:

- **No credential storage** — passwords and tokens are read from your local config file or environment variables at runtime
- **Config written owner-only** — `saveConfig` creates the config directory `0700` and the file `0600`, and tightens an existing file that was left more permissive
- **Passwords need not be stored at all** — `password_command` resolves an account password by running an external command (a password manager CLI, the macOS Keychain) at startup, so no secret is written to `config.toml`
- **Audit logging** — all write operations are logged with automatic redaction of sensitive fields (passwords, email body content)
- **Rate limiting** — configurable rate limits on send operations (default: 10/minute)
- **Read-only mode** — can be configured to disable all write operations
- **Input validation** — all tool inputs are validated with Zod schemas

## Best Practices for Users

- Prefer `password_command` over a plaintext `password` in `config.toml`, so the
  secret stays in your password manager or the OS keychain:
  ```toml
  password_command = "security find-generic-password -s email-mcp-personal -w"
  ```
  The command must print the password to **stdout** only — anything it writes to
  stderr may be quoted back in error messages.
- Use app-specific passwords instead of your main account password — they are
  revocable individually and cannot be used to take over the account
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/email-mcp/audit.jsonl`
- Use `read_only: true` in config if you only need read access
- Keep email-mcp updated to the latest version
