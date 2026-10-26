import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm test discovers top-level suites without shell globbing and propagates failures", () => {
  const root = mkdtempSync(join(tmpdir(), "messcript-test-command-"));
  try {
    const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: {
        build: 'node -e "require(\'node:fs\').writeFileSync(\'built\', \'yes\')"',
        test: scripts.test,
      },
    }));
    const runner = join(repoRoot, "scripts", "run-tests.mjs");
    if (existsSync(runner)) {
      copyFileSync(runner, join(root, "scripts", "run-tests.mjs"));
    }
    writeFileSync(join(root, "test", "sentinel.test.mjs"),
      'import { test } from "node:test"; test("top-level sentinel", () => {});\n');
    writeFileSync(join(root, "test", "helper.mjs"), 'throw new Error("helper ran");\n');
    writeFileSync(join(root, "test", "fixtures", "nested.test.mjs"),
      'throw new Error("nested fixture ran");\n');

    const env = { ...process.env };
    if (process.platform === "win32") {
      delete env.npm_config_script_shell;
      delete env.NPM_CONFIG_SCRIPT_SHELL;
    } else {
      const shell = join(root, "no-glob-shell");
      writeFileSync(shell, '#!/bin/sh\nexec /bin/bash -f "$@"\n');
      chmodSync(shell, 0o755);
      env.npm_config_script_shell = shell;
    }
    const run = () => spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
      cwd: root,
      env,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    const first = run();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(readFileSync(join(root, "built"), "utf8"), "yes");
    assert.match(first.stdout, /ok \d+ - top-level sentinel/);

    writeFileSync(join(root, "test", "new suite.test.mjs"),
      'import { test } from "node:test"; test("new suite with spaces", () => {});\n');
    const added = run();
    assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
    assert.match(added.stdout, /ok \d+ - top-level sentinel/);
    assert.match(added.stdout, /ok \d+ - new suite with spaces/);

    writeFileSync(join(root, "test", "failure.test.mjs"),
      'import { test } from "node:test"; test("intentional failure", () => { throw new Error("failed suite"); });\n');
    const failed = run();
    assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
    assert.match(failed.stdout, /not ok \d+ - intentional failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
