import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(repoRoot, "test", "fixtures");
let consumerRoot;
let workspaceRoot;
let scanRoot;
let executable;

before(() => {
  consumerRoot = mkdtempSync(join(tmpdir(), "messcript-acceptance-"));
  const packageDestination = join(consumerRoot, "package");
  mkdirSync(packageDestination);
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--loglevel", "silent", "--pack-destination", packageDestination],
      { cwd: repoRoot, encoding: "utf8" },
    ),
  );
  const packageTarball = join(packageDestination, packed[0].filename);

  execFileSync(
    "npm",
    ["init", "--yes", "--scope", "acceptance"],
    { cwd: consumerRoot, stdio: "ignore" },
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", packageTarball],
    { cwd: consumerRoot, stdio: "ignore" },
  );
  executable = join(consumerRoot, "node_modules", ".bin", "messcript");

  workspaceRoot = mkdtempSync(join(tmpdir(), "messcript-workspace-"));
  scanRoot = join(workspaceRoot, "tests", "project");
  mkdirSync(scanRoot, { recursive: true });
  const complexSource = readFileSync(join(fixturesRoot, "complex.ts"), "utf8");
  const malformedSource = readFileSync(join(fixturesRoot, "malformed.ts"), "utf8");
  const customSource = complexSource.replace("value: number", "value").replace("): number", ")");
  const writeScanFixture = (relativePath, contents) => {
    const path = join(scanRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  writeScanFixture("src/main.ts", complexSource);
  writeScanFixture("src/main.test.ts", complexSource);
  writeScanFixture("src/custom.source", customSource);
  writeScanFixture("src/broken.ts", malformedSource);
  writeScanFixture("excluded/complex.ts", complexSource);
  for (const directory of ["node_modules", ".git", "generated", "coverage", ".cache", "build", "dist", "output", ".output"]) {
    writeScanFixture(`${directory}/ignored.ts`, complexSource);
  }
});

after(() => {
  rmSync(consumerRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function runCli(args) {
  return spawnSync(executable, args, { encoding: "utf8" });
}

test("the packed package declares its executable and Node range", () => {
  const installedPackage = JSON.parse(
    readFileSync(join(consumerRoot, "node_modules", "messcript", "package.json"), "utf8"),
  );

  assert.equal(installedPackage.bin.messcript, "dist/cli.js");
  assert.equal(installedPackage.engines.node, ">=20.11.0");
});

test("the packed executable prints help", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: messcript <paths> <format> <ruleset/);
  assert.equal(result.stderr, "");
});

test("the packed executable prints its package version", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^messcript \d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, "");
});

test("a missing command shape is an operational error", () => {
  const result = runCli([]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required arguments: <paths> <format> <ruleset/);
  assert.equal(result.stdout, "");
});

test("an unknown option is an operational error", () => {
  const result = runCli(["src", "text", "javascript", "--not-a-real-option"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --not-a-real-option/);
  assert.equal(result.stdout, "");
});

test("help does not hide an unknown option", () => {
  const result = runCli(["--help", "--not-a-real-option"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --not-a-real-option/);
  assert.equal(result.stdout, "");
});

test("help does not hide an extra positional argument", () => {
  const result = runCli(["--help", "extra"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected positional argument: extra/);
  assert.equal(result.stdout, "");
});

test("a clean mixed-source directory exits successfully", () => {
  const result = runCli([join(fixturesRoot, "mixed"), "text", "codesize"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("CyclomaticComplexity reports a stable text finding", () => {
  const result = runCli([join(fixturesRoot, "complex.ts"), "text", "codesize"]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /complex\.ts:\d+:\d+: CyclomaticComplexity \[priority 3\]/);
  assert.match(result.stdout, /function complex\(\)/);
  assert.match(result.stdout, /Cyclomatic Complexity of 13/);
  assert.equal(result.stderr, "");
});

test("a missing input is an operational error", () => {
  const result = runCli([join(fixturesRoot, "missing.ts"), "text", "codesize"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Input path does not exist/);
  assert.equal(result.stdout, "");
});

test("a parse error is an operational error", () => {
  const result = runCli([join(fixturesRoot, "malformed.ts"), "text", "codesize"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed\.ts.*Could not parse/);
  assert.equal(result.stderr, "");
});

test("discovery is deterministic, recursive, and deduplicates overlapping inputs", () => {
  const expected = runCli([scanRoot, "text", "codesize"]);
  const repeated = runCli([`${scanRoot},${join(scanRoot, "src", "main.ts")},${scanRoot}`, "text", "codesize"]);

  assert.equal(repeated.status, expected.status);
  assert.equal(repeated.stdout, expected.stdout);
  assert.equal(repeated.stderr, expected.stderr);
  assert.match(repeated.stdout, /main\.ts/);
  assert.match(repeated.stdout, /main\.test\.ts/);
  assert.match(repeated.stdout, /ProcessingError/);
  assert.doesNotMatch(repeated.stdout, /node_modules|generated|coverage|\.cache|build|dist/);
});

test("tests are included by default and ignored only when requested", () => {
  const included = runCli([scanRoot, "text", "codesize"]);
  const ignored = runCli([scanRoot, "text", "codesize", "--ignore-tests"]);

  assert.match(included.stdout, /main\.test\.ts/);
  assert.match(ignored.stdout, /main\.ts/);
  assert.doesNotMatch(ignored.stdout, /main\.test\.ts/);
  assert.equal(included.stderr, ignored.stderr);
});

test("suffix overrides and path exclusions control discovery", () => {
  const customSuffix = runCli([scanRoot, "text", "codesize", "--suffixes", ".source"]);
  const excluded = runCli([scanRoot, "text", "codesize", "--exclude", join(scanRoot, "excluded")]);

  assert.equal(customSuffix.status, 2);
  assert.match(customSuffix.stdout, /custom\.source/);
  assert.doesNotMatch(customSuffix.stdout, /main\.ts|main\.test\.ts/);
  assert.doesNotMatch(excluded.stdout, /excluded[\\/]complex\.ts/);
});

test("exit-ignore flags change only status, not report content", () => {
  const withErrors = runCli([scanRoot, "text", "codesize"]);
  const errorsIgnored = runCli([scanRoot, "text", "codesize", "--ignore-errors-on-exit"]);
  const violating = runCli([join(scanRoot, "src", "main.ts"), "text", "codesize"]);
  const violationsIgnored = runCli([join(scanRoot, "src", "main.ts"), "text", "codesize", "--ignore-violations-on-exit"]);
  const allIgnored = runCli([
    scanRoot,
    "text",
    "codesize",
    "--ignore-errors-on-exit",
    "--ignore-violations-on-exit",
  ]);

  assert.equal(withErrors.status, 1);
  assert.equal(errorsIgnored.status, 2);
  assert.equal(errorsIgnored.stdout, withErrors.stdout);
  assert.equal(errorsIgnored.stderr, withErrors.stderr);
  assert.equal(violating.status, 2);
  assert.equal(violationsIgnored.status, 0);
  assert.equal(violationsIgnored.stdout, violating.stdout);
  assert.equal(violationsIgnored.stderr, violating.stderr);
  assert.equal(allIgnored.status, 0);
  assert.equal(allIgnored.stdout, withErrors.stdout);
  assert.equal(allIgnored.stderr, withErrors.stderr);
});
