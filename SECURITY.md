# Security policy

## Supported line

Security fixes target the latest stable release and `main`. macOS assets are Developer ID signed and notarized; Debian/Ubuntu desktop assets carry published SHA-256 receipts and are installed through the system package manager.

## Report a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, pairing links, private Host addresses, exported conversations or backup packages.

## Trust boundaries

- Pairing bootstrap tokens are single-use and expire after ten minutes.
- Device credentials are returned once and stored by Host Core only as SHA-256 hashes.
- Secrets configured for model providers stay in the Host secret store and are not returned by inventory APIs.
- APNs provider signing material stays in macOS Keychain or Linux Secret Service; paired clients receive only readiness and delivery receipts, never the key.
- APNs device tokens remain Host-private. Status responses expose only token fingerprints, and a revoked paired device is no longer eligible for delivery.
- Every external wake trigger owns separate fetch, submit, and encryption secrets. Host stores token hashes, an encryption-key fingerprint, ciphertext, an anonymous route id, and a route-scoped wake token; it never receives the APNs provider key, device token, route-owner token, encryption key, or phone-side collaborator/conversation target.
- The official minimal wake relay stores the APNs address behind a separate owner token and accepts only an opaque idempotency request from Host. It receives no Host address, collaborator, conversation, event body, ciphertext, or encryption key.
- macOS credentials use Keychain; Linux desktop credentials use Secret Service, with no plaintext fallback.
- Backup plaintext and passphrases never enter the model tool surface.
- Workspace containers do not receive the device credential.
- External folders require an explicit local grant and can be revoked independently.
- Source plugins are digest-addressed and execute in a fresh restricted process or pinned container with declared permissions.
- Page projects accept only credential-free `https://github.com/<owner>/<repo>` input URLs. Host may use the computer's existing Git authentication, but it does not persist repository credentials in project records; checkpoints and published phone bundles exclude `.git` metadata and reject symbolic links.
- Public deployments must terminate HTTPS at Caddy or another operator-owned reverse proxy.
- Linux release CI audits the production dependency surface with `npm audit --omit=dev`; Electron packaging tools run only against trusted repository input and are not included in the installed Console. The lockfile still pins patched `brace-expansion` releases for every build-tool dependency range.

Run `aru-selfhost doctor` after installation or upgrade. If a credential or pairing link may have leaked, revoke the paired device from a trusted client and generate a new one-time pairing link.
