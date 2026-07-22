import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import ts from "typescript";

export const sourceSuffixes = [
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
] as const;

function isSourceFile(path: string): boolean {
  return sourceSuffixes.some((suffix) => path.endsWith(suffix));
}

function addSourceFiles(path: string, files: Set<string>): void {
  const fileInfo = statSync(path);
  if (fileInfo.isFile()) {
    if (isSourceFile(path)) {
      files.add(path);
    }
    return;
  }

  if (!fileInfo.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(path)) {
    addSourceFiles(resolve(path, entry), files);
  }
}

export function discoverSourceFiles(inputPaths: readonly string[]): string[] {
  const files = new Set<string>();

  for (const inputPath of inputPaths) {
    const path = resolve(inputPath);
    if (!existsSync(path)) {
      throw new Error(`Input path does not exist: ${inputPath}`);
    }
    addSourceFiles(path, files);
  }

  return [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function scriptKindForPath(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return basename(path).endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.Unknown;
  }
}

