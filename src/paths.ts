import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Project root, resolved from this module rather than the current working directory.
 * Works for both `bun run src/...` and compiled `dist/...` layouts.
 */
export const appRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Finds an executable on PATH. A value containing a path separator is treated as an
 * explicit path and checked directly.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (name.includes(path.sep) || name.includes("/")) {
    return isExecutable(name) ? path.resolve(name) : null;
  }

  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * First existing path among the relative candidates, checked against the project root.
 */
export function resolveProjectFile(...relativeCandidates: readonly string[]): string | null {
  for (const candidate of relativeCandidates) {
    const fullPath = path.join(appRootDir, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}
