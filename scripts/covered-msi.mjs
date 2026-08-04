import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {{ files?: Record<string, { mutants?: Array<{ status: string }> }> }} report
 * @param {readonly string[] | undefined} onlyFiles
 */
export function coveredMsiFromReport(report, onlyFiles) {
  const files = report.files ?? {};
  const selected =
    onlyFiles === undefined
      ? Object.values(files)
      : onlyFiles.flatMap((path) => (files[path] ? [files[path]] : []));
  const mutants = selected.flatMap((file) => file.mutants ?? []);
  const counts = {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
  };

  for (const mutant of mutants) {
    if (mutant.status === "Killed") counts.killed += 1;
    if (mutant.status === "Survived") counts.survived += 1;
    if (mutant.status === "NoCoverage") counts.noCoverage += 1;
    if (mutant.status === "Timeout") counts.timeout += 1;
  }

  const covered = counts.killed + counts.survived;
  const coveredMsi = covered === 0 ? 0 : (counts.killed / covered) * 100;

  return { coveredMsi, ...counts };
}

/**
 * @param {string[]} argv
 */
export function parseCoveredMsiArgs(argv) {
  const [reportPath = "coverage/mutation/mutation.json", ...options] = argv;
  const minimumIndex = options.indexOf("--minimum");
  const onlyIndex = options.indexOf("--only");
  const minimum = minimumIndex === -1 ? undefined : Number(options[minimumIndex + 1]);
  const only =
    onlyIndex === -1 || !options[onlyIndex + 1]
      ? undefined
      : options[onlyIndex + 1].split(",").filter(Boolean);

  if (minimumIndex !== -1 && (!Number.isFinite(minimum) || minimum < 0 || minimum > 100)) {
    throw new Error("--minimum must be a number between 0 and 100");
  }

  return { reportPath, minimum, only };
}

async function main(argv) {
  const { reportPath, minimum, only } = parseCoveredMsiArgs(argv);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const { coveredMsi, killed, survived, noCoverage, timeout } = coveredMsiFromReport(
    report,
    only,
  );

  console.log(
    [
      `covered-MSI=${coveredMsi.toFixed(2)}%`,
      `killed=${killed}`,
      `survived=${survived}`,
      `noCoverage=${noCoverage}`,
      `timeout=${timeout}`,
    ].join(" "),
  );

  if (minimum !== undefined && coveredMsi < minimum) {
    console.error(`covered-MSI ${coveredMsi.toFixed(2)}% is below the ${minimum}% minimum`);
    process.exit(1);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry && import.meta.url === entry) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
