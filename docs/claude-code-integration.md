# Claude Code integration status

This change adds the execution adapter missing from Host 0.33.1 and earlier.
It is not a published release yet.

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

An actual CLI 2.1.266 check in an empty temporary workspace reached session
initialization, then returned an expired OAuth session error. The production
adapter reported a failed terminal turn and returned to ready. This proves
startup and authentication-error propagation, not successful account access.
The test workspace was removed. Account-owner login is still required.

Real-account acceptance on 2026-09-27 (macOS, CLI 2.1.283, subscription login),
against an isolated loopback Host with a temporary data directory, on top of the
per-turn execution and cancellation work from `codex/host-runtime-truth`:

- A plain prompt returned a streamed reply and completed.
- Writing a file in the collaborator workspace raised a Host approval; allowing
  it once completed the write and the turn.
- A follow-up turn resumed the Claude session and recalled the previous request.
- Cancelling about six seconds into a long turn, before the CLI had reported
  its session, was confirmed about three seconds later once the CLI exited.
  No CLI process remained and the next message completed.

Without that cancellation work, the same cancel left the turn running and the
conversation refusing new messages, because the cancel could not reach a driver
that had no turn id yet. Native Windows execution still depends on CI.
