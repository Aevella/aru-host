#!/usr/bin/env node
// Windows sibling of bundle-linux-desktop-host-core.sh. Node instead of bash
// so the same bundler runs on Windows CI and macOS/Linux cross-build hosts.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const [destinationInput, version] = process.argv.slice(2);
if (!destinationInput || !version) {
  console.error("usage: bundle-windows-desktop-host-core.mjs <destination> <version>");
  process.exit(1);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$/.test(version)) {
  console.error("invalid version");
  process.exit(1);
}
const destination = resolve(destinationInput);

const files = [
  "aru-selfhost-stub.mjs", "backup-settings.mjs", "conversation-turn-relay.mjs",
  "collaborator-host.mjs", "mobile-collaborator-replicas.mjs", "mobile-collaborator-identities.mjs", "container-runtime-setup.mjs", "collaborator-cognition.mjs", "collaborator-surfaces.mjs",
  "collaborator-surface-bundles.mjs", "collaborator-conversations.mjs", "collaborator-conversation-attachments.mjs",
  "collaborator-initiative.mjs", "collaborator-projects.mjs", "apns-push.mjs", "wake-bridge.mjs",
  "codex-app-server-driver.mjs", "claude-code-host-bridge.mjs",
  "direct-api-driver.mjs", "provider-profiles.mjs",
  "provider-secret-store.mjs", "node-control.mjs", "node-workspaces.mjs",
  "plugin-supervisor.mjs", "plugin-workshop.mjs", "source-plugin-runtime.mjs",
  "source-plugin-runner.mjs", "run-node.ps1", "install-windows.ps1",
  "aru-selfhostctl-windows.ps1",
];

for (const file of files) {
  if (!existsSync(join(scriptDir, file))) {
    console.error(`missing ${file}`);
    process.exit(1);
  }
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const file of files) copyFileSync(join(scriptDir, file), join(destination, file));
writeFileSync(join(destination, "release.json"), `${JSON.stringify({ schema: "aru.host.release.v1", version })}\n`);
