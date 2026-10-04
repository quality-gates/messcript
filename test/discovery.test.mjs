import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { analyze } from "../dist/analyzer.js";
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

test("discoverSourceFiles skips every ignored directory name", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-ignored-"));
  try {
    const ignoredNames = [
      ".cache", ".git", ".hg", ".next", ".nuxt", ".nyc_output", ".output",
      ".parcel-cache", ".svn", ".turbo", "build", "cache", "coverage", "dist",
      "generated", "node_modules", "out", "output", "target", "tmp", "vendor",
    ];
    for (const name of ignoredNames) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "hidden.ts"), "export const x = 1;\n");
    }
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "real.ts"), "export const y = 1;\n");

    const result = discoverSourceFiles([dir]);

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.files, [join(dir, "src", "real.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSourceFiles honors directory and exact-file exclusions without touching similar names", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-excluded-"));
  try {
    mkdirSync(join(dir, "app"), { recursive: true });
    mkdirSync(join(dir, "application"), { recursive: true });
    writeFileSync(join(dir, "app", "inside.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "application", "inside.ts"), "export const b = 1;\n");
    writeFileSync(join(dir, "root.ts"), "export const c = 1;\n");
    writeFileSync(join(dir, "drop.ts"), "export const d = 1;\n");

    const result = discoverSourceFiles([dir], {
      exclusions: [join(dir, "app"), join(dir, "drop.ts")],
    });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.files.map((path) => path.slice(dir.length + 1)).sort(),
      ["application/inside.ts", "root.ts"].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSourceFiles normalizes suffixes with dots and case", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-suffix-"));
  try {
    writeFileSync(join(dir, "typed.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "notes"), "plain text\n");

    const result = discoverSourceFiles([dir], { suffixes: ["TS"] });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.files, [join(dir, "typed.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scriptKindForPath maps every recognized suffix", () => {
  assert.equal(scriptKindForPath("foo.mjs"), ts.ScriptKind.JS);
  assert.equal(scriptKindForPath("foo.cjs"), ts.ScriptKind.JS);
  assert.equal(scriptKindForPath("foo.mts"), ts.ScriptKind.TS);
  assert.equal(scriptKindForPath("foo.cts"), ts.ScriptKind.TS);
  assert.equal(scriptKindForPath("foo.d.ts"), ts.ScriptKind.TS);
  assert.equal(scriptKindForPath("foo.txt"), ts.ScriptKind.JS);
});

test("discoverSourceFiles skips a directory symlink back to its own directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-self-cycle-"));
  try {
    writeFileSync(join(dir, "ok.ts"), "export const VALUE = 1;\n");
    symlinkSync(".", join(dir, "loop"));

    const result = discoverSourceFiles([dir]);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.files, [join(dir, "ok.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSourceFiles terminates on a two-directory symlink cycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-pair-cycle-"));
  try {
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "value.ts"), "export const VALUE = 1;\n");
    symlinkSync(join("..", "a"), join(dir, "a", "b"));

    const result = discoverSourceFiles([dir]);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.files, [join(dir, "a", "value.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSourceFiles follows a directory symlink to an unvisited directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-linked-"));
  try {
    mkdirSync(join(dir, "outside"));
    mkdirSync(join(dir, "root"));
    writeFileSync(join(dir, "outside", "shared.ts"), "export const SHARED = 1;\n");
    symlinkSync(join("..", "outside"), join(dir, "root", "linked"));

    const result = discoverSourceFiles([join(dir, "root")]);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.files, [join(dir, "root", "linked", "shared.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSourceFiles classifies test files relative to the scan root, not ancestors", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-classify-"));
  try {
    const app = join(dir, "tests", "app");
    mkdirSync(join(app, "src", "__tests__"), { recursive: true });
    writeFileSync(join(app, "src", "widget.ts"), "export const x = 1;\n");
    writeFileSync(join(app, "src", "widget.spec.ts"), "export const y = 1;\n");
    writeFileSync(join(app, "src", "__tests__", "helper.ts"), "export const z = 1;\n");

    const result = discoverSourceFiles([join(app, "src")]);
    assert.deepEqual(result.testFiles, [join(app, "src", "__tests__", "helper.ts"), join(app, "src", "widget.spec.ts")]);
    assert.deepEqual(discoverSourceFiles([join(app, "src")], { ignoreTests: true }).files, [join(app, "src", "widget.ts")]);
    assert.deepEqual(discoverSourceFiles([join(app, "src", "__tests__")]).testFiles, [join(app, "src", "__tests__", "helper.ts")]);
    assert.deepEqual(discoverSourceFiles([join(app, "src", "widget.spec.ts")]).testFiles, [join(app, "src", "widget.spec.ts")]);
    assert.deepEqual(discoverSourceFiles([join(app, "src", "widget.ts")]).testFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allow-underscore-test agrees with --ignore-tests regardless of ancestor directory names", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-discovery-underscore-"));
  const selections = ["CamelCaseMethodName", "CamelCasePropertyName"].map((name) => ({
    name,
    rulesetName: "controversial",
    properties: { "allow-underscore-test": "true" },
  }));
  const source = "export class Widget {\n  _field = 1;\n  _renderNow(): void {}\n}\n";
  try {
    for (const ancestor of ["plain", "test", "tests", "spec", "__tests__"]) {
      const src = join(dir, ancestor, "app", "src");
      mkdirSync(join(src, "__tests__"), { recursive: true });
      writeFileSync(join(src, "widget.ts"), source);
      writeFileSync(join(src, "widget.test.ts"), source);
      writeFileSync(join(src, "__tests__", "helper.ts"), source);

      const findings = analyze([src], selections).findings.map((finding) => `${relative(src, finding.path)}:${finding.ruleName}`).sort();
      assert.deepEqual(findings, ["widget.ts:CamelCaseMethodName", "widget.ts:CamelCasePropertyName"], ancestor);
      assert.deepEqual(analyze([src], selections, { ignoreTests: true }).findings.length, 2, ancestor);
      assert.deepEqual(analyze([join(src, "__tests__")], selections).findings, [], `${ancestor} test root`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
