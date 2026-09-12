import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, unlink, mkdtemp, rm, chmod } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);

export function runtimeCandidates(platform = process.platform, env = process.env) {
  const roots = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (platform === "darwin") roots.push("/opt/podman/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Applications/Docker.app/Contents/Resources/bin");
  if (platform === "win32") {
    roots.push(join(env.ProgramFiles ?? "C:\\Program Files", "RedHat", "Podman"),
      join(env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin"),
      join(env.LOCALAPPDATA ?? homedir(), "Programs", "Podman"));
  }
  return [...new Set(roots.flatMap(root => ["podman", "docker"].map(name => join(root, name + (platform === "win32" ? ".exe" : "")))))];
}

export function replaceRuntime(contents, executable, platform = process.platform) {
  if (/[\r\n\0]/.test(executable)) throw new Error("Invalid container executable path");
  // Unix node.env is sourced by bash; Windows node.env is read as literal values.
  const value = platform === "win32" ? executable : "'" + executable.replaceAll("'", "'\\''") + "'";
  const line = `ARU_CONTAINER_RUNTIME=${value}`;
  return /^ARU_CONTAINER_RUNTIME=.*$/m.test(contents)
    ? contents.replace(/^ARU_CONTAINER_RUNTIME=.*$/m, () => line)
    : contents + (contents.endsWith("\n") ? "" : "\n") + line + "\n";
}

export async function configureContainerRuntime(configPath, {
  platform = process.platform, candidates = runtimeCandidates(platform), run = execute,
} = {}) {
  const original = await readFile(configPath, "utf8");
  const setting = (key, fallback) => original.match(new RegExp(`^ARU_${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "") || fallback;
  let executable;
  for (const candidate of candidates) {
    try {
      await run(candidate, ["info"], { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      executable = candidate;
      break;
    } catch { /* An installed CLI with a stopped engine is not ready. */ }
  }
  if (!executable) throw new Error("No running container engine found. Install and start Podman Desktop or Docker Desktop, then try again. On Linux, configure rootless Podman for the Host user.");
  const directory = await mkdtemp(join(tmpdir(), "aru-container-check-"));
  try {
    await chmod(directory, 0o777);
    await writeFile(join(directory, "input.txt"), "aru-runtime-check", { mode: 0o644 });
    for (const [key, fallback, command] of [
      ["NODE", "node:22-alpine", ["node", "-e", "const f=require('fs');if(f.readFileSync('/workspace/input.txt','utf8')!=='aru-runtime-check')process.exit(1);f.writeFileSync('/workspace/node.txt','ok')"]],
      ["PYTHON", "python:3.13-alpine", ["python3", "-c", "from pathlib import Path; assert Path('/workspace/input.txt').read_text() == 'aru-runtime-check'; Path('/workspace/python.txt').write_text('ok')"]],
      ["SHELL", "alpine:3.22", ["sh", "-c", "test \"$(cat /workspace/input.txt)\" = aru-runtime-check && printf ok > /workspace/shell.txt"]],
    ]) {
      const configured = setting(`${key}_IMAGE`, fallback);
      // Pulling images can take minutes; cancellation/engine errors are failures,
      // not a reason to save an unverified runtime. No fixed download deadline.
      await run(executable, ["run", "--rm", "--init", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "65532:65532",
        "--pids-limit", "128", "--memory", setting("CONTAINER_MEMORY", "1g"),
        "--cpus", setting("CONTAINER_CPUS", "2"), "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--workdir", "/workspace",
        "--mount", `type=bind,src=${directory},dst=/workspace,rw`, configured || fallback, ...command],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    }
    for (const name of ["node", "python", "shell"]) {
      if (await readFile(join(directory, `${name}.txt`), "utf8") !== "ok") throw new Error("Container workspace write verification failed");
    }
    // Do not overwrite settings changed during image preparation.
    if (await readFile(configPath, "utf8") !== original) throw new Error("Host settings changed during preparation. Try again.");
    const temporary = `${configPath}.runtime-${process.pid}`;
    try {
      await writeFile(temporary, replaceRuntime(original, executable, platform), { mode: 0o600, flag: "wx" });
      await rename(temporary, configPath);
    } finally { await unlink(temporary).catch(() => {}); }
    return executable;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureContainerRuntime(process.argv[2]).then(runtime => {
    console.log(`Verified Node, Python and Shell container jobs: ${runtime}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
