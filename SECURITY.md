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
- **Audit logging** — all write operations are logged with automatic redaction of sensitive fields (passwords, email body content)
- **Rate limiting** — configurable rate limits on send operations (default: 10/minute)
- **Read-only mode** — can be configured to disable all write operations
- **Input validation** — all tool inputs are validated with Zod schemas

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/email-mcp/audit.jsonl`
- Use `read_only: true` in config if you only need read access
- Keep email-mcp updated to the latest version
