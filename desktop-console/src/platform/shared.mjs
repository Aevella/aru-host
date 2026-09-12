import { spawn } from "node:child_process";

// Secrets travel over stdin/stdout only; they must never appear in argv.
export function runWithInput(command, args, input, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let errorText = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("Secure credential operation timed out"));
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errorText += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(errorText.trim() || "Secure credential operation failed"));
    });
    child.stdin.end(input);
  });
}
