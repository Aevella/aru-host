# Claude Code integration status

This change adds the execution adapter missing from Host 0.31.3 and earlier.
It is not a published release yet. Real-account acceptance is pending.

Host runs an installed Claude Code CLI under the same operating-system user,
using print mode, stream-json, session resume, and a per-turn stdio MCP bridge.
The CLI owns authentication; Host owns the conversation ledger, tool dispatch,
approvals, and attachments. Signing in to Claude Desktop alone does not establish
CLI authentication. Use `claude auth login`, then `claude auth status` under the
user running Host. Login failures must surface as failed turns.

The adapter handles streamed text, resumed sessions, Host tools, approval requests,
attachment manifests, and cancellation. Windows npm installations invoke their
JavaScript entry through Node without a shell; native executables run directly.
macOS discovery also searches Desktop-managed CLI versions and user package-manager
locations when the service PATH omits them.

Local verification on 2026-09-14: Claude protocol smoke, collaborator routing,
command/discovery tests (three pass, one Windows-only test pending CI), HTTP smoke,
Linux script installer, macOS script installer, and Linux payload generation passed.
The protocol smoke uses a controlled CLI fixture and real stdio bridge; it does not
establish successful Claude service access. Native Windows CI, real-account response,
tool approval, resume, and cancellation remain separate acceptance requirements.

Official protocol: https://code.claude.com/docs/en/headless
Authentication: https://code.claude.com/docs/en/authentication
