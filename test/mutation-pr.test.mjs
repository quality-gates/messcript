import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  listChangedProductionFiles,
  parseNameOnlyDiff,
  selectProductionSourceFiles,
} from "../scripts/changed-production-files.mjs";
import {
  buildStrykerMutateArgs,
  parseMutationPrArgs,
  runMutationPr,
} from "../scripts/mutation-pr.mjs";
import { coveredMsiFromReport } from "../scripts/covered-msi.mjs";

test("selectProductionSourceFiles keeps only src TypeScript production files", () => {
  assert.deepEqual(
    selectProductionSourceFiles([
      "src/cli.ts",
      "src/rules/unused.ts",
      "test/cli.test.mjs",
      "README.md",
      "stryker.config.json",
      "src/rules/unused.js",
      "scripts/covered-msi.mjs",
      "src/nested/path/file.ts",
    ]),
    ["src/cli.ts", "src/rules/unused.ts", "src/nested/path/file.ts"],
  );
});

test("selectProductionSourceFiles rejects path-traversal lookalikes outside src", () => {
  assert.deepEqual(
    selectProductionSourceFiles([
      "not-src/cli.ts",
      "src.ts",
      "src",
      "./src/cli.ts",
      "src/cli.ts",
    ]),
    ["src/cli.ts"],
  );
});

test("parseNameOnlyDiff trims blank lines from git name-only output", () => {
  assert.deepEqual(parseNameOnlyDiff("src/cli.ts\n\nREADME.md\n"), ["src/cli.ts", "README.md"]);
});

test("listChangedProductionFiles asks git for ACMR paths under src and filters to .ts", () => {
  const calls = [];
  const files = listChangedProductionFiles({
    base: "origin/main",
    gitDiff: (args) => {
      calls.push(args);
      return "src/cli.ts\nsrc/rules/unused.js\ntest/cli.test.mjs\n";
    },
  });

  assert.deepEqual(calls, [
    ["diff", "--name-only", "--diff-filter=ACMR", "origin/main...HEAD", "--", "src/"],
  ]);
  assert.deepEqual(files, ["src/cli.ts"]);
});

test("buildStrykerMutateArgs refuses an empty production set", () => {
  assert.throws(() => buildStrykerMutateArgs([]), /no production/);
});

test("buildStrykerMutateArgs uses incremental mode with a coverage-local incremental file", () => {
  assert.deepEqual(buildStrykerMutateArgs(["src/cli.ts", "src/rules/unused.ts"]), [
    "run",
    "--incremental",
    "--incrementalFile",
    "coverage/mutation/stryker-incremental.json",
    "--mutate",
    "src/cli.ts,src/rules/unused.ts",
  ]);
});

test("parseMutationPrArgs reads base and optional minimum", () => {
  assert.deepEqual(parseMutationPrArgs(["--base", "origin/main", "--minimum", "80"]), {
    base: "origin/main",
    minimum: 80,
  });
});

test("coveredMsiFromReport scores only the requested production files", () => {
  const report = {
    files: {
      "src/cli.ts": {
        mutants: [{ status: "Killed" }, { status: "Survived" }],
      },
      "src/other.ts": {
        mutants: [{ status: "Survived" }, { status: "Survived" }, { status: "Survived" }],
      },
    },
  };

  assert.deepEqual(coveredMsiFromReport(report, ["src/cli.ts"]), {
    coveredMsi: 50,
    killed: 1,
    survived: 1,
    noCoverage: 0,
    timeout: 0,
  });
});

test("runMutationPr skips Stryker when no production files changed", () => {
  const commands = [];
  const result = runMutationPr({
    base: "origin/main",
    minimum: 80,
    listFiles: () => [],
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.status, 0);
  assert.deepEqual(commands, []);
});

test("runMutationPr mutates only the changed production files then checks scoped covered-MSI", () => {
  const commands = [];
  const result = runMutationPr({
    base: "origin/main",
    minimum: 80,
    listFiles: () => ["src/cli.ts"],
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.status, 0);
  assert.deepEqual(commands[0], [
    "stryker",
    "run",
    "--incremental",
    "--incrementalFile",
    "coverage/mutation/stryker-incremental.json",
    "--mutate",
    "src/cli.ts",
  ]);
  assert.equal(commands[1][0], process.execPath);
  assert.deepEqual(commands[1].slice(1), [
    "scripts/covered-msi.mjs",
    "coverage/mutation/mutation.json",
    "--only",
    "src/cli.ts",
    "--minimum",
    "80",
  ]);
});

test("covered-msi CLI --only ignores out-of-scope files in the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "covered-msi-"));
  try {
    const reportPath = join(dir, "mutation.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        files: {
          "src/cli.ts": { mutants: [{ status: "Killed" }] },
          "src/other.ts": { mutants: [{ status: "Survived" }] },
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/covered-msi.mjs", reportPath, "--only", "src/cli.ts", "--minimum", "80"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /covered-MSI=100\.00%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
