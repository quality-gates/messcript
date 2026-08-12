import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  listChangedProductionFiles,
  listChangedProductionMutateEntries,
} from "./changed-production-files.mjs";

/**
 * @param {readonly string[]} mutateEntries
 * @returns {string[]}
 */
export function buildStrykerMutateArgs(mutateEntries) {
  if (mutateEntries.length === 0) {
    throw new Error("no production files to mutate");
  }

  return [
    "run",
    "--incremental",
    "--incrementalFile",
    "coverage/mutation/stryker-incremental.json",
    "--mutate",
    mutateEntries.join(","),
  ];
}

/**
 * @param {string[]} argv
 * @returns {{ base: string, minimum: number | undefined }}
 */
export function parseMutationPrArgs(argv) {
  const baseIndex = argv.indexOf("--base");
  const minimumIndex = argv.indexOf("--minimum");

  if (baseIndex === -1 || !argv[baseIndex + 1]) {
    throw new Error("usage: node scripts/mutation-pr.mjs --base <ref> [--minimum <n>]");
  }

  const minimum =
    minimumIndex === -1 ? undefined : Number(argv[minimumIndex + 1]);

  if (minimumIndex !== -1 && (!Number.isFinite(minimum) || minimum < 0 || minimum > 100)) {
    throw new Error("--minimum must be a number between 0 and 100");
  }

  return { base: argv[baseIndex + 1], minimum };
}

/**
 * Strip optional `:start-end` mutation ranges for covered-MSI --only scoping.
 *
 * @param {readonly string[]} mutateEntries
 * @returns {string[]}
 */
export function productionFilesFromMutateEntries(mutateEntries) {
  return [...new Set(mutateEntries.map((entry) => entry.replace(/:\d+-\d+$/, "")))];
}

/**
 * @param {{
 *   base: string,
 *   minimum?: number,
 *   listFiles?: (options: { base: string }) => string[],
 *   listMutateEntries?: (options: { base: string }) => string[],
 *   runCommand?: (command: string, args: string[]) => { status: number | null, stdout: string, stderr: string },
 * }} options
 * @returns {{ skipped: boolean, files: string[], status: number }}
 */
export function runMutationPr({
  base,
  minimum,
  listFiles = listChangedProductionFiles,
  listMutateEntries = listChangedProductionMutateEntries,
  runCommand = (command, args) =>
    spawnSync(command, args, { encoding: "utf8", stdio: "inherit" }),
}) {
  const mutateEntries = listMutateEntries({ base });
  const files =
    mutateEntries.length > 0
      ? productionFilesFromMutateEntries(mutateEntries)
      : listFiles({ base });

  if (mutateEntries.length === 0) {
    console.log(
      `No changed production source files vs ${base}; skipping mutation testing.`,
    );
    return { skipped: true, files, status: 0 };
  }

  console.log(
    `Mutating changed production code:\n${mutateEntries.map((entry) => `  ${entry}`).join("\n")}`,
  );

  const stryker = runCommand("stryker", buildStrykerMutateArgs(mutateEntries));
  if ((stryker.status ?? 1) !== 0) {
    return { skipped: false, files, status: stryker.status ?? 1 };
  }

  const scoreArgs = [
    "scripts/covered-msi.mjs",
    "coverage/mutation/mutation.json",
    "--only",
    files.join(","),
  ];
  if (minimum !== undefined) {
    scoreArgs.push("--minimum", String(minimum));
  }

  const score = runCommand(process.execPath, scoreArgs);
  return { skipped: false, files, status: score.status ?? 1 };
}

function main(argv) {
  const { base, minimum } = parseMutationPrArgs(argv);
  const result = runMutationPr({ base, minimum });
  process.exit(result.status);
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
