import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let consumerRoot;
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
});

after(() => {
  rmSync(consumerRoot, { recursive: true, force: true });
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
