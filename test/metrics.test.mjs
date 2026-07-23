import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { calculateNPathComplexity } from "../dist/metrics/complexity.js";
import { findGlobalVariable } from "../dist/rules/global-variable.js";
import { findCouplingBetweenObjects } from "../dist/rules/coupling-between-objects.js";
import { calculateLcom4 } from "../dist/metrics/cohesion.js";
import { findLackOfCohesionOfMethods } from "../dist/rules/lack-of-cohesion-of-methods.js";

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

test("CouplingBetweenObjects reports the exact dependency count at its threshold", () => {
  const sourceFile = ts.createSourceFile(
    "coupling-metric.ts",
    "class Exact { first: First; second: Second; third(value: Third): Fourth { return new Fifth(); } }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const finding = findCouplingBetweenObjects(sourceFile, 5).find((item) => item.context === "class Exact");
  assert.ok(finding);
  assert.match(finding.message, /value of 5/);
});

test("LCOM4 ignores helpers and accessors while joining receiver calls", () => {
  const sourceFile = ts.createSourceFile(
    "cohesion-metric.ts",
    `class Service {
  left = 0;
  right = 0;
  addLeft() { this.left += 1; }
  addRight() { this.right += 1; }
  leftValue() { return this.left + 1; }
  rightValue() { return this.right + 1; }
  leftTotal() { return this.leftValue(); }
  rightTotal() { return this.rightValue(); }
  helper() { return 1; }
  get leftAlias() { return this.left; }
  set leftAlias(value) { this.left = value; }
  overloaded(value: string): string;
  overloaded(value: number): string;
  overloaded(value: string | number) { return String(value); }
}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const classNode = sourceFile.statements[0];
  assert.ok(ts.isClassDeclaration(classNode));
  assert.equal(calculateLcom4(classNode), 2);
  const finding = findLackOfCohesionOfMethods(sourceFile)[0];
  assert.equal(finding.priority, 3);
  assert.equal(finding.message, "The class Service has a Lack of Cohesion Of Methods (LCOM4) value of 2. Consider to split this class into 2 smaller classes.");
  assert.equal(findLackOfCohesionOfMethods(sourceFile, 2).length, 0);
});

test("LCOM4 keeps static and instance state relationships separate", () => {
  const sourceFile = ts.createSourceFile(
    "static-cohesion.ts",
    `class Mixed {
  value = 0;
  static value = 0;
  read() { return this.value; }
  write() { this.value += 1; }
  static read() { return this.value; }
  static write() { this.value += 1; }
}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const classNode = sourceFile.statements[0];
  assert.ok(ts.isClassDeclaration(classNode));
  assert.equal(calculateLcom4(classNode), 2);
});
