import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { analyzeUnused } from "../dist/analysis/unused.js";
import { createUnusedFinding, unusedOfKind } from "../dist/rules/unused-finding.js";
import { findUnusedFormalParameter } from "../dist/rules/unused-formal-parameter.js";
import { findUnusedLocalVariable, properties as localProperties } from "../dist/rules/unused-local-variable.js";
import { findUnusedPrivateField } from "../dist/rules/unused-private-field.js";
import { findUnusedPrivateMethod } from "../dist/rules/unused-private-method.js";

function sourceFile(source, fileName = "unused.ts") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function findingNames(findings) {
  return findings.map((finding) => finding.message.match(/'([^']+)'/)?.[1]).filter(Boolean);
}

test("unused analysis distinguishes used, unused, private, local, formal, and uncertain declarations", () => {
  const file = sourceFile(`
class Service {
  public publicField = 0;
  protected protectedField = 0;
  private unusedField = 1;
  private typedField: number = 1;
  private readOnlyField: number;
  private static unusedStaticField = 1;
  private static usedStaticField = 2;
  private usedField = 2;
  #unusedPrivate = 3;
  #usedPrivate = 4;
  private writeOnly = 5;
  private usedViaElement = 6;
  private unusedMethod() { return 1; }
  private usedMethod() { return this.usedField; }
  private #unusedMethod() { return 1; }
  private #usedMethod() { return this.#usedPrivate; }
  private static unusedStaticMethod() { return 1; }
  private static usedStaticMethod() { return Service.usedStaticField; }
  private [computedPrivate]() { return 1; }
  private overload(value: string): string;
  private overload(value: number): string;
  private overload(value: string | number): string { return String(value); }

  constructor(private unusedParameterProperty: number, private usedParameterProperty: number, public publicParameterProperty: number) {
    this.usedParameterProperty;
    this.usedMethod();
    this.#usedMethod();
    Service.usedStaticField;
    Service.usedStaticMethod();
  }

  run(usedParameter, unusedParameter, _ignoredParameter, { used: usedDestructured, unused: unusedDestructured }) {
    const usedLocal = usedParameter;
    const unusedLocal = 1;
    const { used: usedNested, unused: unusedNested } = values;
    for (const usedLoop of values) { const loopResult = usedLoop; return loopResult; }
    this.usedViaElement;
    this["usedViaElement"];
    this.writeOnly = 2;
    try { return usedLocal + usedDestructured + usedNested + this.usedField; }
    catch (unusedCatch) { return usedLocal; }
  }
}

function closure(usedParameter, unusedClosureParameter, _ignoredClosureParameter) {
  const captured = 1;
  return () => captured + usedParameter;
}

function recursive(value) {
  return value > 0 ? recursive(value - 1) : 0;
}

function typed(typedParameter: Namespace.Type = fallback) {
  return typedParameter;
}

function overloadOnly(value: string): string;
function overloadOnly(value: number): string;
function overloadOnly(value: string | number) { return String(value); }
declare function ambient(ambientParameter: string): void;
declare class Ambient { private unusedField: number; private unusedMethod(): void; }

type Box<T extends Base = Default> = { value: T; nested: Namespace.Type };
interface Contract<T extends Base = Default> { method(value: T): Namespace.Type; }
const computedKey = "key";
const source = { key: 1 };
const fallback = 1;
const unusedModuleBinding = 1;
const { [computedKey]: alias = fallback } = source;
const object = { [computedKey]: alias, value: source.value };
const External = class {
  private unusedExternal = 1;
  private usedExternal = 2;
};
External.usedExternal;
`);

  const declarations = analyzeUnused(file);
  const declarationsOf = (kind) => declarations.filter((declaration) => declaration.kind === kind).map((declaration) => `${declaration.name}:${declaration.used}`).sort();

  assert.deepEqual(declarationsOf("privateField"), [
    "#unusedPrivate:false",
    "#usedPrivate:true",
    "unusedExternal:false",
    "unusedField:false",
    "readOnlyField:false",
    "unusedStaticField:false",
    "usedStaticField:true",
    "typedField:false",
    "unusedParameterProperty:false",
    "usedExternal:true",
    "usedField:true",
    "usedParameterProperty:true",
    "usedViaElement:true",
    "writeOnly:false",
  ].sort());
  assert.deepEqual(declarationsOf("privateMethod"), [
    "#unusedMethod:false",
    "#usedMethod:true",
    "unusedMethod:false",
    "usedMethod:true",
    "unusedStaticMethod:false",
    "usedStaticMethod:true",
    "overload:false",
  ].sort());
  assert.deepEqual(declarationsOf("formal"), [
    "_ignoredClosureParameter:false",
    "_ignoredParameter:false",
    "unusedClosureParameter:false",
    "unusedDestructured:false",
    "unusedParameter:false",
    "usedDestructured:true",
    "usedParameter:true",
    "usedParameter:true",
    "typedParameter:true",
    "value:true",
    "value:true",
    "value:true",
  ].sort());
  assert.deepEqual(declarationsOf("local"), [
    "captured:true",
    "loopResult:true",
    "unusedCatch:false",
    "unusedLocal:false",
    "unusedNested:false",
    "usedLocal:true",
    "usedNested:true",
    "usedLoop:true",
  ].sort());

  assert.equal(declarations.find((declaration) => declaration.name === "unusedField")?.context, "private field unusedField");
  assert.equal(declarations.find((declaration) => declaration.name === "unusedMethod")?.context, "private method unusedMethod()");
  assert.equal(declarations.find((declaration) => declaration.name === "unusedParameter")?.context, "formal parameter unusedParameter");
  assert.equal(declarations.find((declaration) => declaration.name === "unusedLocal")?.context, "local variable unusedLocal");
  assert.equal(declarations.some((declaration) => declaration.name === "computedPrivate"), false);
  assert.equal(declarations.some((declaration) => declaration.name === "unusedModuleBinding"), false);
  assert.equal(declarations.some((declaration) => declaration.name === "ambientParameter"), false);
  assert.equal(declarations.some((declaration) => declaration.context.includes("Ambient")), false);
  assert.equal(declarations.some((declaration) => declaration.name === "publicField"), false);
  assert.equal(declarations.some((declaration) => declaration.name === "protectedField"), false);

  assert.deepEqual(findingNames(findUnusedPrivateField(file, declarations)).sort(), [
    "#unusedPrivate", "readOnlyField", "typedField", "unusedExternal", "unusedField", "unusedParameterProperty", "unusedStaticField", "writeOnly",
  ].sort());
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file, declarations)).sort(), ["#unusedMethod", "overload", "unusedMethod", "unusedStaticMethod"]);
  assert.deepEqual(findingNames(findUnusedFormalParameter(file, declarations)).sort(), ["unusedClosureParameter", "unusedDestructured", "unusedParameter"]);
  assert.doesNotMatch(findingNames(findUnusedFormalParameter(file, declarations)).join("\n"), /_/);

  localProperties.exceptions = "unusedLocal,unusedDestructured";
  assert.deepEqual(findingNames(findUnusedLocalVariable(file, declarations)).sort(), ["unusedCatch", "unusedNested"]);
  localProperties.exceptions = "";
  assert.deepEqual(findingNames(findUnusedLocalVariable(file, declarations)).sort(), ["unusedCatch", "unusedLocal", "unusedNested"]);
});

test("unused rules preserve exact messages, locations, and kind filtering", () => {
  const file = sourceFile("function work(ignored) {\n  const local = 1;\n}");
  const node = file.statements[0].body.statements[0].declarationList.declarations[0].name;
  const declarations = [
    { name: "local", node, kind: "local", context: "local variable local", used: false },
    { name: "used", node, kind: "local", context: "local variable used", used: true },
    { name: "parameter", node, kind: "formal", context: "formal parameter parameter", used: false },
  ];

  assert.deepEqual(unusedOfKind(declarations, "local").map((declaration) => declaration.name), ["local"]);
  const localFinding = findUnusedLocalVariable(file, declarations)[0];
  assert.deepEqual(localFinding, {
    path: "unused.ts",
    line: 2,
    column: 9,
    ruleName: "UnusedLocalVariable",
    priority: 3,
    context: "local variable local",
    message: "Avoid unused local variables such as 'local'.",
  });
  assert.deepEqual(findUnusedFormalParameter(file, declarations).map((finding) => finding.message), ["Avoid unused parameters such as 'parameter'."]);
  assert.deepEqual(createUnusedFinding(declarations[0], file, "CustomRule", "custom message"), {
    path: "unused.ts",
    line: 2,
    column: 9,
    ruleName: "CustomRule",
    priority: 3,
    context: "local variable local",
    message: "custom message",
  });
});

test("unused references cover private writes, computed access, type-only syntax, and imports", () => {
  const file = sourceFile(`
import { Imported } from "module";
class Access {
  private readDot = 1;
  private readHash = 2;
  private readString = 3;
  private writeOnly = 4;
  private readExternal = 5;
  read() {
    this.readDot;
    this.#readHash;
    this["readString"];
    this.writeOnly = 1;
    Access.readExternal;
  }
}
type Qualified = Namespace.Type;
type Generic<T extends Imported = Default> = T;
interface Shape { value: Qualified; method(input: Generic<string>): void; }
const key = "readDot";
const values = { [key]: 1 };
const { [key]: alias = values[key] } = values;
`);
  const declarations = analyzeUnused(file);
  const fields = declarations.filter((declaration) => declaration.kind === "privateField");
  assert.equal(fields.find((declaration) => declaration.name === "readDot")?.used, true);
  assert.equal(fields.find((declaration) => declaration.name === "readHash")?.used, true);
  assert.equal(fields.find((declaration) => declaration.name === "readString")?.used, true);
  assert.equal(fields.find((declaration) => declaration.name === "writeOnly")?.used, false);
  assert.equal(fields.find((declaration) => declaration.name === "readExternal")?.used, true);
  assert.equal(declarations.some((declaration) => declaration.name === "Imported"), false);
});
