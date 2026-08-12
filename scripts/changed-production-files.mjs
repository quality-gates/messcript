import { execFileSync } from "node:child_process";

const PRODUCTION_SOURCE = /^src\/.+\.ts$/;

/**
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function selectProductionSourceFiles(paths) {
  return paths.filter((path) => PRODUCTION_SOURCE.test(path));
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseNameOnlyDiff(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Parse unified-diff hunks into inclusive 1-based line ranges for the new file.
 * Supports `git diff -U0` output (`@@ -l,s +l,s @@`).
 *
 * @param {string} diff
 * @returns {Map<string, Array<{ start: number, end: number }>>}
 */
export function parseUnifiedDiffRanges(diff) {
  /** @type {Map<string, Array<{ start: number, end: number }>>} */
  const rangesByFile = new Map();
  let currentFile;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length).trim();
      if (!rangesByFile.has(currentFile)) {
        rangesByFile.set(currentFile, []);
      }
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      currentFile = undefined;
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !currentFile) {
      continue;
    }

    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (!Number.isFinite(start) || start < 1 || !Number.isFinite(count) || count <= 0) {
      continue;
    }

    rangesByFile.get(currentFile)?.push({ start, end: start + count - 1 });
  }

  return rangesByFile;
}

/**
 * Merge overlapping/adjacent inclusive ranges.
 *
 * @param {readonly { start: number, end: number }[]} ranges
 * @returns {Array<{ start: number, end: number }>}
 */
export function mergeLineRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  /** @type {Array<{ start: number, end: number }>} */
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

/**
 * Build Stryker `--mutate` entries. New files mutate fully; edited files use line ranges.
 *
 * @param {readonly string[]} productionFiles
 * @param {ReadonlyMap<string, readonly { start: number, end: number }[]>} rangesByFile
 * @returns {string[]}
 */
export function buildMutateEntries(productionFiles, rangesByFile) {
  /** @type {string[]} */
  const entries = [];
  for (const file of productionFiles) {
    const ranges = rangesByFile.get(file);
    if (!ranges || ranges.length === 0) {
      entries.push(file);
      continue;
    }
    for (const range of mergeLineRanges(ranges)) {
      entries.push(`${file}:${range.start}-${range.end}`);
    }
  }
  return entries;
}

/**
 * @param {{ base: string, gitDiff?: (args: string[]) => string }} options
 * @returns {string[]}
 */
export function listChangedProductionFiles({
  base,
  gitDiff = (args) => execFileSync("git", args, { encoding: "utf8" }),
}) {
  const stdout = gitDiff([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
    "--",
    "src/",
  ]);

  return selectProductionSourceFiles(parseNameOnlyDiff(stdout));
}

/**
 * @param {{ base: string, gitDiff?: (args: string[]) => string }} options
 * @returns {string[]}
 */
export function listChangedProductionMutateEntries({
  base,
  gitDiff = (args) => execFileSync("git", args, { encoding: "utf8" }),
}) {
  const files = listChangedProductionFiles({ base, gitDiff });
  if (files.length === 0) {
    return [];
  }

  const diff = gitDiff([
    "diff",
    "-U0",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
    "--",
    ...files,
  ]);
  const rangesByFile = parseUnifiedDiffRanges(diff);
  return buildMutateEntries(files, rangesByFile);
}
