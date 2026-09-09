import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { discoverSourceFiles, scriptKindForPath } from "../dist/discovery.js";

test("discoverSourceFiles matches uppercase and mixed-case extensions the same as lowercase", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-"));
  try {
    writeFileSync(join(dir, "UpperComponent.TSX"), "export const x = 1;\n");
    writeFileSync(join(dir, "mixedComponent.TsX"), "export const y = 1;\n");
    writeFileSync(join(dir, "lowerComponent.tsx"), "export const z = 1;\n");

    const result = discoverSourceFiles([dir], { suffixes: ["tsx"] });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.files.map((path) => path.slice(dir.length + 1)).sort(),
      ["UpperComponent.TSX", "lowerComponent.tsx", "mixedComponent.TsX"].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSourceFiles classifies a test scan root and an explicit test file with --ignore-tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-tests-"));
  try {
    for (const directory of ["test", "tests", "spec", "__tests__"]) {
      mkdirSync(join(dir, directory), { recursive: true });
      writeFileSync(join(dir, directory, "helper.ts"), "export const x = 1;\n");
    }
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "bar.ts"), "export const y = 1;\n");
    writeFileSync(join(dir, "app", "foo.test.ts"), "export const z = 1;\n");
    writeFileSync(join(dir, "app", "foo.spec.tsx"), "export const w = 1;\n");

    for (const directory of ["test", "tests", "spec", "__tests__"]) {
      assert.deepEqual(discoverSourceFiles([join(dir, directory)], { ignoreTests: true }).files, []);
    }
    assert.deepEqual(discoverSourceFiles([join(dir, "app", "foo.test.ts")], { ignoreTests: true }).files, []);
    assert.deepEqual(discoverSourceFiles([join(dir, "app", "foo.spec.tsx")], { ignoreTests: true }).files, []);
    assert.deepEqual(
      discoverSourceFiles([join(dir, "app")], { ignoreTests: true }).files,
      [join(dir, "app", "bar.ts")],
    );
    assert.deepEqual(
      discoverSourceFiles([dir], {}).files.map((path) => path.slice(dir.length + 1)).sort(),
      [
        join("__tests__", "helper.ts"),
        join("app", "bar.ts"),
        join("app", "foo.spec.tsx"),
        join("app", "foo.test.ts"),
        join("spec", "helper.ts"),
        join("test", "helper.ts"),
        join("tests", "helper.ts"),
      ].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scriptKindForPath treats uppercase .d.ts the same as lowercase", () => {
  assert.equal(scriptKindForPath("FOO.D.TS"), scriptKindForPath("foo.d.ts"));
  assert.equal(scriptKindForPath("FOO.D.TS"), ts.ScriptKind.TS);
});

test("scriptKindForPath is case-insensitive for mixed-case .d.ts", () => {
  assert.equal(scriptKindForPath("Bar.D.Ts"), ts.ScriptKind.TS);
});

test("scriptKindForPath still resolves lowercase suffixes correctly", () => {
  assert.equal(scriptKindForPath("foo.ts"), ts.ScriptKind.TS);
  assert.equal(scriptKindForPath("foo.tsx"), ts.ScriptKind.TSX);
  assert.equal(scriptKindForPath("foo.jsx"), ts.ScriptKind.JSX);
  assert.equal(scriptKindForPath("foo.js"), ts.ScriptKind.JS);
  assert.equal(scriptKindForPath("foo.d.ts"), ts.ScriptKind.TS);
});
