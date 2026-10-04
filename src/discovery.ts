// messcript-disable ConstantNamingConventions
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { isTestContextDirectory, isTestContextFileName } from "./rules/test-context";

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

const ignoredDirectoryNames = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".nyc_output",
  ".output",
  ".parcel-cache",
  ".svn",
  ".turbo",
  "build",
  "cache",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "output",
  "target",
  "tmp",
  "vendor",
]);

export type DiscoveryOptions = {
  suffixes?: readonly string[];
  exclusions?: readonly string[];
  ignoreTests?: boolean;
};

export type DiscoveryError = {
  path: string;
  message: string;
};

export type DiscoveryResult = {
  files: string[];
  /** The discovered files that are test files relative to the scan root that reached them. */
  testFiles: string[];
  errors: DiscoveryError[];
};

function normalizedSuffixes(suffixes: readonly string[]): string[] {
  return [...new Set(suffixes.map((suffix) => (suffix.startsWith(".") ? suffix : `.${suffix}`).toLowerCase()))];
}

function isSourceFile(path: string, suffixes: readonly string[]): boolean {
  const lowerCasePath = path.toLowerCase();
  return suffixes.some((suffix) => lowerCasePath.endsWith(suffix));
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}${sep}`));
}

// A path relative to the scan root cannot name the root itself, so a root that
// is a test directory and an explicitly passed test file need their own checks.
function isTestPath(path: string, rootPath: string): boolean {
  return isTestContextFileName(relative(rootPath, path)) || isTestContextFileName(basename(path)) || isTestContextDirectory(rootPath);
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function addSourceFiles(
  path: string,
  rootPath: string,
  files: Map<string, boolean>,
  errors: DiscoveryError[],
  options: Required<DiscoveryOptions>,
  visitedDirectories: Set<string>,
): void {
  const isTest = isTestPath(path, rootPath);
  if (isExcluded(path, options.exclusions) || (options.ignoreTests && isTest)) {
    return;
  }

  let fileInfo;
  try {
    fileInfo = statSync(path);
  } catch (error) {
    errors.push({
      path,
      message: `Could not inspect ${path}: ${error instanceof Error ? error.message : "Unknown discovery error"}`,
    });
    return;
  }
  if (fileInfo.isFile()) {
    if (isSourceFile(path, options.suffixes)) {
      // A file another scan root reached as a non-test file stays a non-test file,
      // just as --ignore-tests keeps it.
      files.set(path, (files.get(path) ?? true) && isTest);
    }
    return;
  }

  if (!fileInfo.isDirectory()) {
    return;
  }

  // A directory symlink back to a walked directory would otherwise be followed
  // until ELOOP. statSync follows links, so device and inode name the target.
  const directoryIdentity = `${fileInfo.dev}:${fileInfo.ino}`;
  if (visitedDirectories.has(directoryIdentity)) {
    return;
  }
  visitedDirectories.add(directoryIdentity);

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    errors.push({
      path,
      message: `Could not read directory ${path}: ${error instanceof Error ? error.message : "Unknown discovery error"}`,
    });
    return;
  }

  for (const entry of entries) {
    const entryPath = resolve(path, entry);
    if (ignoredDirectoryNames.has(entry.toLowerCase())) {
      continue;
    }
    addSourceFiles(entryPath, rootPath, files, errors, options, visitedDirectories);
  }
}

export function discoverSourceFiles(inputPaths: readonly string[], discoveryOptions: DiscoveryOptions = {}): DiscoveryResult {
  const files = new Map<string, boolean>();
  const errors: DiscoveryError[] = [];
  const visitedDirectories = new Set<string>();
  const options: Required<DiscoveryOptions> = {
    suffixes: normalizedSuffixes(discoveryOptions.suffixes ?? sourceSuffixes),
    exclusions: (discoveryOptions.exclusions ?? []).map((path) => resolve(path)),
    ignoreTests: discoveryOptions.ignoreTests ?? false,
  };

  for (const inputPath of inputPaths) {
    const path = resolve(inputPath);
    if (!existsSync(path)) {
      throw new Error(`Input path does not exist: ${inputPath}`);
    }
    addSourceFiles(path, path, files, errors, options, visitedDirectories);
  }

  // The default sort compares UTF-16 code units, so the order does not depend on locale.
  const sortedFiles = [...files.keys()].sort();
  return {
    files: sortedFiles,
    testFiles: sortedFiles.filter((path) => files.get(path)),
    errors,
  };
}

// messcript-disable-next-line CyclomaticComplexity
export function scriptKindForPath(path: string, suffixes: readonly string[] = sourceSuffixes): ts.ScriptKind {
  const suffix = normalizedSuffixes(suffixes).find((candidate) => path.toLowerCase().endsWith(candidate));

  switch (suffix) {
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
      return basename(path).toLowerCase().endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  }
}
