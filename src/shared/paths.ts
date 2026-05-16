import path from "node:path";
import { mkdir } from "node:fs/promises";

export function projectRootFromCwd(): string {
  return process.cwd();
}

export function defaultDataDir(cwd = projectRootFromCwd()): string {
  return path.resolve(cwd, "data");
}

export function resolveMaybeRelative(baseDir: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function displayPath(value: string): string {
  return path.normalize(value);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
