import { readFile } from "node:fs/promises";

const [reportPath = "coverage/mutation/mutation.json", ...options] = process.argv.slice(2);
const minimumIndex = options.indexOf("--minimum");
const minimum = minimumIndex === -1 ? undefined : Number(options[minimumIndex + 1]);

if (minimumIndex !== -1 && (!Number.isFinite(minimum) || minimum < 0 || minimum > 100)) {
  console.error("--minimum must be a number between 0 and 100");
  process.exit(1);
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
const mutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
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

console.log(
  [
    `covered-MSI=${coveredMsi.toFixed(2)}%`,
    `killed=${counts.killed}`,
    `survived=${counts.survived}`,
    `noCoverage=${counts.noCoverage}`,
    `timeout=${counts.timeout}`,
  ].join(" "),
);

if (minimum !== undefined && coveredMsi < minimum) {
  console.error(`covered-MSI ${coveredMsi.toFixed(2)}% is below the ${minimum}% minimum`);
  process.exit(1);
}
