import { lstat, realpath } from "node:fs/promises";
import { parse, relative, resolve, sep } from "node:path";

// Return one ordinary filesystem entry without crossing a symbolic path component.
// Windows realpath expands 8.3 names, so spelling equality is not an identity check there.
export async function directPathEntry(path) {
  const requested = resolve(path);
  const state = await lstat(requested);
  if (state.isSymbolicLink()) return null;

  if (process.platform === "win32") {
    const root = parse(requested).root;
    const remainder = relative(root, requested);
    let current = root;
    for (const part of remainder.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) return null;
    }
  }

  const physical = await realpath(requested);
  if (process.platform !== "win32" && physical !== requested) return null;
  return { physical, requested, state };
}
