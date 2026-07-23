// messcript-disable ConstantNamingConventions
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
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

const testDirectoryNames = new Set(["__spec__", "__specs__", "__test__", "__tests__", "spec", "specs", "test", "tests"]);

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
  errors: DiscoveryError[];
};

function normalizedSuffixes(suffixes: readonly string[]): string[] {
  return [...new Set(suffixes.map((suffix) => (suffix.startsWith(".") ? suffix : `.${suffix}`).toLowerCase()))];
}

function isSourceFile(path: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => path.endsWith(suffix));
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}${sep}`));
}

function isTestPath(path: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, path);
  const pathParts = relativePath.split(sep);
  return (
    pathParts.slice(0, -1).some((part) => testDirectoryNames.has(part.toLowerCase())) ||
    /\.(?:test|spec)\.[^.]+$/i.test(basename(path))
  );
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function addSourceFiles(
  path: string,
  rootPath: string,
  files: Set<string>,
  errors: DiscoveryError[],
  options: Required<DiscoveryOptions>,
): void {
  if (isExcluded(path, options.exclusions) || (options.ignoreTests && isTestPath(path, rootPath))) {
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
      files.add(path);
    }
    return;
  }

  if (!fileInfo.isDirectory()) {
    return;
  }

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
    addSourceFiles(entryPath, rootPath, files, errors, options);
  }
}

export function discoverSourceFiles(inputPaths: readonly string[], discoveryOptions: DiscoveryOptions = {}): DiscoveryResult {
  const files = new Set<string>();
  const errors: DiscoveryError[] = [];
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
    addSourceFiles(path, path, files, errors, options);
  }

  return {
    files: [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    errors,
  };
}

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
      return basename(path).endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  }
}
