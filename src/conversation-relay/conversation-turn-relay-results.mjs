import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Raw provider response storage. Turn state and acknowledgement stay with the
// relay; this owner only manages temporary writes and atomic publication.
export function createTurnResultFiles(directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".tmp")) rmSync(join(directory, name), { force: true });
  }
  return {
    create(name) { writeFileSync(join(directory, name), Buffer.alloc(0), { mode: 0o600 }); },
    append(name, chunk) { appendFileSync(join(directory, name), Buffer.from(chunk)); },
    finish(temporary, final) { renameSync(join(directory, temporary), join(directory, final)); },
    read(name) {
      const path = join(directory, name);
      return existsSync(path) ? readFileSync(path) : null;
    },
    remove(name) { rmSync(join(directory, name), { force: true }); },
    removePath(path) { rmSync(path, { force: true }); },
  };
}
