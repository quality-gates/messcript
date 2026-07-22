import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { calculateNPathComplexity } from "../dist/metrics/complexity.js";
import { findGlobalVariable } from "../dist/rules/global-variable.js";

function functionBody(source) {
  const sourceFile = ts.createSourceFile("metric-fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements[0].body;
}

function arrowBody(source) {
  const sourceFile = ts.createSourceFile("metric-fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements[0].declarationList.declarations[0].initializer.body;
}

test("NPath counts conditional paths in expression-bodied arrows", () => {
  assert.equal(calculateNPathComplexity(arrowBody("const choose = (value) => value ? 1 : 0;")), 2);
});

test("NPath counts optional and nullish decisions in direct returns", () => {
  assert.equal(calculateNPathComplexity(functionBody("function read(value) { return value?.next ?? 0; }")), 3);
});

test("GlobalVariable report-immutable includes otherwise quiet module bindings", () => {
  const sourceFile = ts.createSourceFile(
    "global-property.ts",
    "const immutable = 1; let quiet = 2; importValue;",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = findGlobalVariable([sourceFile], true);
  assert.deepEqual(findings.map((finding) => finding.message.match(/state: (.+)\.$/)?.[1]), ["immutable", "quiet"]);
});
