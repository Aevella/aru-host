import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selfhost = resolve(root, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const hostCore = resolve(root, ".host-core");
const icons = resolve(root, ".build-icons");

const platformFlag = process.argv.indexOf("--platform");
const targetPlatform = platformFlag !== -1
  ? process.argv[platformFlag + 1]
  : process.platform === "win32" ? "windows" : "linux";
if (!["linux", "windows"].includes(targetPlatform)) {
  console.error(`unsupported bundle platform: ${targetPlatform}`);
  process.exit(1);
}

rmSync(hostCore, { recursive: true, force: true });
mkdirSync(icons, { recursive: true });
if (targetPlatform === "windows") {
  execFileSync(process.execPath, [
    resolve(selfhost, "bundle-windows-desktop-host-core.mjs"), hostCore, pkg.version,
  ], { stdio: "inherit" });
} else {
  execFileSync(resolve(selfhost, "bundle-linux-desktop-host-core.sh"), [hostCore, pkg.version], {
    stdio: "inherit",
  });
}
await sharp(resolve(root, "assets/icon.svg")).resize(512, 512).png().toFile(resolve(icons, "icon.png"));
