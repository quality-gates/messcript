import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
 * @param {readonly string[]} productionFiles
 * @returns {string[]}
 */
export function buildStrykerMutateArgs(productionFiles) {
  if (productionFiles.length === 0) {
    throw new Error("no production files to mutate");
  }

  return ["run", "--incremental", "--force", "--mutate", productionFiles.join(",")];
}

/**
 * @param {{ base: string, head?: string, gitDiff?: (args: string[]) => string }} options
 * @returns {string[]}
 */
export function listChangedProductionFiles({
  base,
  head = "HEAD",
  gitDiff = (args) => execFileSync("git", args, { encoding: "utf8" }),
}) {
  const stdout = gitDiff([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${base}...${head}`,
    "--",
    "src/",
  ]);

  return selectProductionSourceFiles(parseNameOnlyDiff(stdout));
}

function parseArgs(argv) {
  const baseIndex = argv.indexOf("--base");
  if (baseIndex === -1 || !argv[baseIndex + 1]) {
    throw new Error("usage: node scripts/changed-production-files.mjs --base <ref>");
  }

  return { base: argv[baseIndex + 1] };
}

function main(argv) {
  const { base } = parseArgs(argv);
  const files = listChangedProductionFiles({ base });
  process.stdout.write(files.join("\n") + (files.length > 0 ? "\n" : ""));
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry && import.meta.url === entry) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
