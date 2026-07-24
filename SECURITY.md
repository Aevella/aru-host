# Security policy

## Supported line

Security fixes target the latest stable release and `main`. macOS assets are Developer ID signed and notarized; Debian/Ubuntu desktop assets carry published SHA-256 receipts and are installed through the system package manager.

## Report a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, pairing links, private Host addresses, exported conversations or backup packages.

## Trust boundaries

- Pairing bootstrap tokens are single-use and expire after ten minutes.
- Device credentials are returned once and stored by Host Core only as SHA-256 hashes.
- Secrets configured for model providers stay in the Host secret store and are not returned by inventory APIs.
- macOS credentials use Keychain; Linux desktop credentials use Secret Service, with no plaintext fallback.
- Backup plaintext and passphrases never enter the model tool surface.
- Workspace containers do not receive the device credential.
- External folders require an explicit local grant and can be revoked independently.
- Source plugins are digest-addressed and execute in a fresh restricted process or pinned container with declared permissions.
- Public deployments must terminate HTTPS at Caddy or another operator-owned reverse proxy.

Run `aru-selfhost doctor` after installation or upgrade. If a credential or pairing link may have leaked, revoke the paired device from a trusted client and generate a new one-time pairing link.
