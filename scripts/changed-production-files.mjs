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
