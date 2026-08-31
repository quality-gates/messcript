import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { scriptKindForPath } from "../dist/discovery.js";

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
