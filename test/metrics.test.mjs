import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { calculateNPathComplexity } from "../dist/metrics/complexity.js";

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

