# Public Host release check

Before every push, tag, or GitHub release, manually review the complete tracked repository, not only the current diff.

- Check filenames and contents for real people, device names, local paths, credentials, pairing links, exports, crash/build output, signing material, and other private state. Automated scans assist this pass but never replace it; stop when a hit cannot be proved synthetic or intentionally public.
- Compare the public Host owner files with the current private source slice and explain every intentional difference.
- Verify the release version and Host protocol across README, changelog, package metadata, fixtures, installers, and workflows, then run the focused Host Core, macOS Console, and Linux Console checks before publication.
