import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { analyze } from "../dist/analyzer.js";
import { analyzeOverloads } from "../dist/ast/overloads.js";
import { findShortMethodName } from "../dist/rules/short-method-name.js";
import { findShortVariable } from "../dist/rules/short-variable.js";
import { findCamelCaseMethodName } from "../dist/rules/camel-case-method-name.js";
import { findCamelCaseParameterName } from "../dist/rules/camel-case-parameter-name.js";
import { findBooleanGetMethodName } from "../dist/rules/boolean-get-method-name.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sourceFile(source, fileName = "repro.ts") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

test("function declaration overloads emit exactly one ShortMethodName finding", () => {
  const file = sourceFile(`
export function ov(a: string): string;
export function ov(a: number): number;
export function ov(a: unknown): unknown { return a; }
`);
  const findings = findShortMethodName(file);
  assert.equal(findings.length, 1, `expected 1 ShortMethodName finding, got ${findings.length}`);
  assert.deepEqual(findings[0].declarationLines, [2, 3, 4]);
});

test("parameter naming rules emit at most one finding per parameter across overloads", () => {
  const file = sourceFile(`
export function ov(a: string): string;
export function ov(a: number): number;
export function ov(a: unknown): unknown { return a; }
`);
  const findings = findShortVariable(file);
  assert.equal(findings.length, 1, `expected 1 ShortVariable finding for parameter a, got ${findings.length}`);
  assert.deepEqual(findings[0].declarationLines, [2, 3, 4]);
});

test("ambient function overloads emit at most one finding per declared name", () => {
  const file = sourceFile(`
declare function ov(a: string): string;
declare function ov(a: number): number;
`);
  const methodFindings = findShortMethodName(file);
  assert.equal(methodFindings.length, 1, `expected 1 ShortMethodName finding, got ${methodFindings.length}`);
  assert.deepEqual(methodFindings[0].declarationLines, [2, 3]);
  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 1, `expected 1 ShortVariable finding for parameter a, got ${paramFindings.length}`);
  assert.deepEqual(paramFindings[0].declarationLines, [2, 3]);
});

test("class method overloads emit at most one finding per method and per parameter", () => {
  const file = sourceFile(`
class Service {
  static ov(p: string): string;
  static ov(p: number): number;
  static ov(p: unknown): unknown { return p; }

  ov(p: string): string;
  ov(p: number): number;
  ov(p: unknown): unknown { return p; }
}
`);
  const methodFindings = findShortMethodName(file);
  assert.equal(methodFindings.length, 2, `expected 2 findings (1 static, 1 instance), got ${methodFindings.length}`);
  assert.deepEqual(methodFindings[0].declarationLines, [3, 4, 5]);
  assert.deepEqual(methodFindings[1].declarationLines, [7, 8, 9]);

  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 2, `expected 2 findings (1 for static param, 1 for instance param), got ${paramFindings.length}`);
  assert.deepEqual(paramFindings[0].declarationLines, [3, 4, 5]);
  assert.deepEqual(paramFindings[1].declarationLines, [7, 8, 9]);
});

test("constructor overloads deduplicate parameter findings across signatures", () => {
  const file = sourceFile(`
class Service {
  constructor(a: string);
  constructor(a: number);
  constructor(a: unknown) {}
}
`);
  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 1, `expected 1 finding for constructor parameter a, got ${paramFindings.length}`);
  assert.deepEqual(paramFindings[0].declarationLines, [3, 4, 5]);
});

test("interface method signature overloads emit at most one finding per name", () => {
  const file = sourceFile(`
interface Handler {
  bad_name(a: string): string;
  bad_name(a: number): number;
}
`);
  const methodFindings = findCamelCaseMethodName(file);
  assert.equal(methodFindings.length, 1, `expected 1 CamelCaseMethodName finding, got ${methodFindings.length}`);
  assert.deepEqual(methodFindings[0].declarationLines, [3, 4]);

  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 1, `expected 1 ShortVariable finding for parameter a, got ${paramFindings.length}`);
  assert.deepEqual(paramFindings[0].declarationLines, [3, 4]);
});

test("CamelCaseParameterName deduplicates parameter findings across overloads", () => {
  const file = sourceFile(`
function test(bad_param: string): string;
function test(bad_param: number): number;
function test(bad_param: unknown): unknown { return bad_param; }
`);
  const findings = findCamelCaseParameterName(file);
  assert.equal(findings.length, 1, `expected 1 CamelCaseParameterName finding, got ${findings.length}`);
  assert.deepEqual(findings[0].declarationLines, [2, 3, 4]);
});

test("BooleanGetMethodName evaluates overloaded methods with implementation body once", () => {
  const file = sourceFile(`
function getFlag(): boolean;
function getFlag(): boolean;
function getFlag(): boolean { return true; }
`);
  const findings = findBooleanGetMethodName(file);
  assert.equal(findings.length, 1, `expected 1 BooleanGetMethodName finding, got ${findings.length}`);
  assert.equal(findings[0].line, 2);
  assert.deepEqual(findings[0].declarationLines, [2, 3, 4]);
});

test("BooleanGetMethodName evaluates overloaded class methods with implementation body once", () => {
  const file = sourceFile(`
class Service {
  getFlag(): boolean;
  getFlag(): boolean;
  getFlag(): boolean { return true; }
}
`);
  const findings = findBooleanGetMethodName(file);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.deepEqual(findings[0].declarationLines, [3, 4, 5]);
});

test("call signatures and construct signatures in interfaces deduplicate parameters", () => {
  const file = sourceFile(`
interface Callable {
  (a: string): string;
  (a: number): number;
}
interface Constructable {
  new (a: string): unknown;
  new (a: number): unknown;
}
`);
  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 2);
  assert.deepEqual(paramFindings[0].declarationLines, [3, 4]);
  assert.deepEqual(paramFindings[1].declarationLines, [7, 8]);
});

test("type literal method signatures deduplicate findings", () => {
  const file = sourceFile(`
type Handler = {
  bad_name(a: string): string;
  bad_name(a: number): number;
};
`);
  const methodFindings = findCamelCaseMethodName(file);
  assert.equal(methodFindings.length, 1);
  assert.deepEqual(methodFindings[0].declarationLines, [3, 4]);
  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 1);
  assert.deepEqual(paramFindings[0].declarationLines, [3, 4]);
});

test("arrow functions, function expressions, and type nodes evaluate parameters and names", () => {
  const file = sourceFile(`
const arrow = (p: string) => p;
const expr = function(p: number) { return p; };
type FnType = (p: boolean) => void;
type CtorType = new (p: symbol) => void;
`);
  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 4);
  assert.deepEqual(paramFindings[0].declarationLines, [2]);
  assert.deepEqual(paramFindings[1].declarationLines, [3]);
  assert.deepEqual(paramFindings[2].declarationLines, [4]);
  assert.deepEqual(paramFindings[3].declarationLines, [5]);
});

test("class accessors evaluate names and parameters", () => {
  const file = sourceFile(`
class Service {
  get bad_get(): number { return 1; }
  set bad_set(p: number) {}
}
`);
  const methodFindings = findCamelCaseMethodName(file);
  assert.equal(methodFindings.length, 2);
  assert.deepEqual(methodFindings[0].declarationLines, [3]);
  assert.deepEqual(methodFindings[1].declarationLines, [4]);

  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 1);
  assert.deepEqual(paramFindings[0].declarationLines, [4]);
});

test("analyzeOverloads caches results per source file", () => {
  const file = sourceFile("function test() {}");
  assert.equal(analyzeOverloads(file), analyzeOverloads(file));
});

test("functions and methods without overloads continue to be evaluated as before", () => {
  const file = sourceFile(`
function normal(val: string): string { return val; }
function ab(p: number): number { return p; }
`);
  const methodFindings = findShortMethodName(file);
  assert.equal(methodFindings.length, 1);
  assert.equal(methodFindings[0].message.includes("ab"), true);

  const paramFindings = findShortVariable(file);
  assert.equal(paramFindings.length, 1);
  assert.equal(paramFindings[0].message.includes("p"), true);
});

test("suppression before overload block or implementation signature suppresses method and parameter findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "messcript-suppr-"));
  try {
    const file1 = join(dir, "top-suppressed.ts");
    writeFileSync(file1, `
// messcript-disable-next-line ShortMethodName ShortVariable
export function ov(a: string): string;
export function ov(a: number): number;
export function ov(a: unknown): unknown { return a; }
`);
    const res1 = analyze([file1], ["naming"], {});
    const methodFindings1 = res1.findings.filter((f) => f.ruleName === "ShortMethodName");
    const paramFindings1 = res1.findings.filter((f) => f.ruleName === "ShortVariable");
    assert.equal(methodFindings1.length, 0, `expected 0 method findings when suppressed before overload block, got ${methodFindings1.length}`);
    assert.equal(paramFindings1.length, 0, `expected 0 param findings when suppressed before overload block, got ${paramFindings1.length}`);

    const file2 = join(dir, "impl-suppressed.ts");
    writeFileSync(file2, `
export function ov(a: string): string;
export function ov(a: number): number;
// messcript-disable-next-line ShortMethodName ShortVariable
export function ov(a: unknown): unknown { return a; }
`);
    const res2 = analyze([file2], ["naming"], {});
    const methodFindings2 = res2.findings.filter((f) => f.ruleName === "ShortMethodName");
    const paramFindings2 = res2.findings.filter((f) => f.ruleName === "ShortVariable");
    assert.equal(methodFindings2.length, 0, `expected 0 method findings when suppressed before implementation signature, got ${methodFindings2.length}`);
    assert.equal(paramFindings2.length, 0, `expected 0 param findings when suppressed before implementation signature, got ${paramFindings2.length}`);

    const file3 = join(dir, "boolean-suppressed.ts");
    writeFileSync(file3, `
// messcript-disable-next-line BooleanGetMethodName
export function getFlag(): boolean;
export function getFlag(): boolean;
export function getFlag(): boolean { return true; }
`);
    const res3 = analyze([file3], ["naming"], {});
    const boolFindings = res3.findings.filter((f) => f.ruleName === "BooleanGetMethodName");
    assert.equal(boolFindings.length, 0, `expected 0 BooleanGetMethodName findings, got ${boolFindings.length}`);

    const file4 = join(dir, "param-line-suppressed.ts");
    writeFileSync(file4, `
export function multiLine(
  // messcript-disable-next-line ShortVariable
  p: string,
): string;
export function multiLine(p: unknown): unknown { return p; }
`);
    const res4 = analyze([file4], ["naming"], {});
    const paramFindings4 = res4.findings.filter((f) => f.ruleName === "ShortVariable");
    assert.equal(paramFindings4.length, 0, `expected 0 ShortVariable findings, got ${paramFindings4.length}`);

    const file5 = join(dir, "camel-suppressed.ts");
    writeFileSync(file5, `
// messcript-disable-next-line CamelCaseMethodName
export function bad_name(a: string): string;
export function bad_name(a: number): number;
export function bad_name(a: unknown): unknown { return a; }
`);
    const res5 = analyze([file5], ["naming"], {});
    const camelFindings5 = res5.findings.filter((f) => f.ruleName === "CamelCaseMethodName");
    assert.equal(camelFindings5.length, 0);

    const file6 = join(dir, "camel-impl-suppressed.ts");
    writeFileSync(file6, `
export function bad_name(a: string): string;
export function bad_name(a: number): number;
// messcript-disable-next-line CamelCaseMethodName
export function bad_name(a: unknown): unknown { return a; }
`);
    const res6 = analyze([file6], ["naming"], {});
    const camelFindings6 = res6.findings.filter((f) => f.ruleName === "CamelCaseMethodName");
    assert.equal(camelFindings6.length, 0);

    const file7 = join(dir, "interface-suppressed.ts");
    writeFileSync(file7, `
interface Handler {
  // messcript-disable-next-line CamelCaseMethodName
  bad_name(a: string): string;
  bad_name(a: number): number;
}
`);
    const res7 = analyze([file7], ["naming"], {});
    const camelFindings7 = res7.findings.filter((f) => f.ruleName === "CamelCaseMethodName");
    assert.equal(camelFindings7.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
