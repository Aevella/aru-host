import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWithInput } from "./shared.mjs";
import { desktopReleaseAsset } from "../runtime.mjs";

const POWERSHELL = "powershell.exe";
const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createWindowsPlatform({
  homeDir,
  env = process.env,
  serviceName,
  credentialAccount,
  execFile = promisify(execFileCallback),
  fileExists = existsSync,
  readTextFile = (path) => readFile(path, "utf8"),
  writeSecretInput = runWithInput,
} = {}) {
  const baseRoot = env.ARU_WINDOWS_BASE_ROOT
    ?? join(env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"), "AruHost");
  const instanceRoot = join(baseRoot, "instances", "home");
  const installEnvPath = join(instanceRoot, "config", "install.env");
  const currentRoot = join(instanceRoot, "current");
  const controlScript = join(currentRoot, "aru-selfhostctl-windows.ps1");
  const taskName = "Aru Host (home)";
  const credentialPath = join(baseRoot, "secrets", serviceName, `${credentialAccount}.dpapi`);

  function runPowerShellCommand(script, options = {}) {
    return execFile(POWERSHELL, [...POWERSHELL_FLAGS, "-Command", script], {
      timeout: 30_000,
      windowsHide: true,
      ...options,
    });
  }

  function runControl(args, options = {}) {
    return execFile(POWERSHELL, [...POWERSHELL_FLAGS, "-File", controlScript, "-Instance", "home", ...args], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  }

  return {
    id: "windows",
    secretStorageId: "windows-dpapi",
    nodeEnvPath: join(instanceRoot, "config", "node.env"),
    installEnvPath,

    hostInstalled() {
      return fileExists(controlScript);
    },

    async runInstaller(hostCoreRoot, releaseVersion) {
      await execFile(POWERSHELL, [
        ...POWERSHELL_FLAGS,
        "-File", join(hostCoreRoot, "install-windows.ps1"),
        "-SourceDir", hostCoreRoot,
        "-Instance", "home",
        "-ReleaseVersion", releaseVersion,
      ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    },

    async setupContainerRuntime() {
      return runControl(["setup-runtime"], { timeout: 0 });
    },

    async startService() {
      await runPowerShellCommand(`Start-ScheduledTask -TaskName ${psQuote(taskName)}`);
    },

    async restartService() {
      await runPowerShellCommand(
        `Stop-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue; `
        + `Start-ScheduledTask -TaskName ${psQuote(taskName)}`,
      );
    },

    async uninstallHost() {
      await runControl(["uninstall"]);
    },

    async issuePairingOutput() {
      const { stdout } = await runControl(["pairing"], { timeout: 45_000, maxBuffer: 1024 * 1024 });
      return stdout;
    },

    // Console credential protection is Windows DPAPI (CurrentUser scope): the
    // ciphertext file is useless off this user account, and there is no
    // plaintext fallback path. exit 44 mirrors the "not found" convention.
    async readCredential() {
      const script = [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Security",
        `$p=${psQuote(credentialPath)}`,
        "if(!(Test-Path -LiteralPath $p)){exit 44}",
        "$c=[IO.File]::ReadAllBytes($p)",
        "$b=[Security.Cryptography.ProtectedData]::Unprotect($c,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
      ].join("; ");
      try {
        const { stdout } = await runPowerShellCommand(script);
        return stdout.replace(/[\r\n]+$/, "") || null;
      } catch (error) {
        if (error.code === 44) return null;
        throw new Error("Windows data protection could not read the Console credential");
      }
    },

    async writeCredential(value) {
      const script = [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Security",
        `$p=${psQuote(credentialPath)}`,
        "$s=[Console]::In.ReadToEnd().TrimEnd(\"`r\",\"`n\")",
        "if($s.Length -eq 0){exit 1}",
        "New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $p) | Out-Null",
        "$b=[Text.Encoding]::UTF8.GetBytes($s)",
        "$c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[IO.File]::WriteAllBytes($p,$c)",
      ].join("; ");
      await writeSecretInput(POWERSHELL, [...POWERSHELL_FLAGS, "-Command", script], `${value}\n`);
    },

    async deleteCredential() {
      const script = [
        `$p=${psQuote(credentialPath)}`,
        "if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}",
      ].join("; ");
      await runPowerShellCommand(script);
    },

    releaseAssetName(version, arch = process.arch) {
      return desktopReleaseAsset("windows", version, arch);
    },

    // Live truth from Windows Firewall, not an installer receipt: loopback
    // keeps working without the rule, but LAN pairing stays blocked until an
    // inbound rule for the Host exists.
    async firewallState() {
      const script = `if(Get-NetFirewallRule -DisplayName ${psQuote(taskName)} -ErrorAction SilentlyContinue){exit 0}else{exit 3}`;
      try {
        await runPowerShellCommand(script);
        return "configured";
      } catch (error) {
        if (error.code === 3) return "unconfigured";
        return "unknown";
      }
    },

    // Recovery path for the blocked-LAN state: one explicit UAC consent adds a
    // private-profile inbound rule scoped to the Host's Node binary and port.
    async configureFirewall() {
      let port = 8787;
      let program = null;
      try {
        const contents = String(await readTextFile(join(instanceRoot, "config", "node.env")));
        const portMatch = contents.match(/^ARU_PORT=([0-9]+)\r?$/m);
        if (portMatch) port = Number(portMatch[1]);
        const nodeMatch = contents.match(/^ARU_NODE_BINARY=(.*)$/m);
        const nodeBinary = nodeMatch?.[1].trim().replace(/^['"]|['"]$/g, "");
        if (nodeBinary) program = nodeBinary;
      } catch {}
      const rule = [
        `New-NetFirewallRule -DisplayName ${psQuote(taskName)}`,
        "-Direction Inbound -Action Allow -Protocol TCP",
        `-LocalPort ${port} -Profile Private,Domain`,
        program ? `-Program ${psQuote(program)}` : null,
        "| Out-Null",
      ].filter(Boolean).join(" ");
      const elevated = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell.exe -ArgumentList `
        + `'-NoProfile','-NonInteractive','-Command',${psQuote(rule)}`;
      await runPowerShellCommand(elevated, { timeout: 120_000 });
    },
  };
}
