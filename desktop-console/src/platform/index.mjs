import { createLinuxPlatform } from "./linux.mjs";
import { createWindowsPlatform } from "./windows.mjs";

// One Console, one Host truth: platforms differ only in background lifetime,
// filesystem layout, secret outlet, and release asset naming. Everything the
// renderer sees goes through the same neutral contract.
export function createDesktopPlatform(context, platform = process.platform) {
  if (platform === "linux") return createLinuxPlatform(context);
  if (platform === "win32") return createWindowsPlatform(context);
  throw new Error(`Aru Host Console does not support this platform: ${platform}`);
}
