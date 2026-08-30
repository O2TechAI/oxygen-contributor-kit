import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../../../tools/atomic_rename.py", import.meta.url));

export function publishDirectoryNoReplace(source, destination, fail, {
  exists = "OUTPUT_EXISTS",
  unavailable = "ATOMIC_PUBLICATION_UNAVAILABLE",
} = {}) {
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, [helper, source, destination], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.status === 0) return;
  if (result.status === 17) fail(exists);
  fail(unavailable);
}
