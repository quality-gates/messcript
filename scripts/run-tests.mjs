import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const tests = readdirSync("test", { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => join("test", entry.name))
  .sort();

if (tests.length === 0) {
  throw new Error("No top-level test/*.test.mjs files found");
}

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
