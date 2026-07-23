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

  execFileSync("npm", ["init", "--yes", "--scope", "acceptance"], {
    cwd: consumerRoot,
    stdio: "ignore",
  });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", packageTarball], {
    cwd: consumerRoot,
    stdio: "ignore",
  });
  executable = join(consumerRoot, "node_modules", ".bin", "messcript");
});

after(() => {
  rmSync(consumerRoot, { recursive: true, force: true });
});

function runPackagedCli(args) {
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
  const result = runPackagedCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: messcript <paths> <format> <ruleset/);
  assert.equal(result.stderr, "");
});

test("the packed executable prints its package version", () => {
  const result = runPackagedCli(["--version"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^messcript \d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, "");
});
