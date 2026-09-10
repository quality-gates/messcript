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

test("UnusedLocalVariable honors the foreach allowance", () => {
  const file = sourceFile(`
declare const values: number[];
declare const records: { nested: number }[];
function loop() {
  for (const item of values) {}
  for (const { nested } of records) {}
}
`);
  const previous = localProperties["allow-unused-foreach-variables"];
  try {
    localProperties["allow-unused-foreach-variables"] = true;

    assert.deepEqual(findingNames(findUnusedLocalVariable(file)), []);
  } finally {
    localProperties["allow-unused-foreach-variables"] = previous;
  }
});

test("UnusedLocalVariable treats var declarations as function-scoped bindings", () => {
  const file = sourceFile(`
function blockScopedVar() {
  if (true) {
    var value = 1;
  }
  return value;
}

function redeclaredVar() {
  var value = 1;
  var value = 2;
  return value;
}
`);

  assert.deepEqual(findingNames(findUnusedLocalVariable(file)), []);
});

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

test("string-literal private member names match dot and element access", () => {
  const file = sourceFile(`
class Service {
  private "usedMethod"() {}
  private "usedField" = 1;
  private "unusedMethod"() {}
  private "unusedField" = 2;
  run() {
    this.usedMethod();
    this["usedMethod"]();
    this.usedField;
    this["usedField"];
  }
}
`);
  const declarations = analyzeUnused(file);

  assert.deepEqual(
    declarations
      .filter(({ kind }) => kind === "privateMethod" || kind === "privateField")
      .map(({ kind, name, used }) => ({ kind, name, used }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [
      { kind: "privateField", name: "unusedField", used: false },
      { kind: "privateMethod", name: "unusedMethod", used: false },
      { kind: "privateField", name: "usedField", used: true },
      { kind: "privateMethod", name: "usedMethod", used: true },
    ],
  );
  assert.deepEqual(findingNames(findUnusedPrivateField(file, declarations)), ["unusedField"]);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file, declarations)), ["unusedMethod"]);
});

test("destructuring this marks private fields and methods as used", () => {
  const file = sourceFile(`
class Service {
  private count = 1;
  private log() {}
  private asField = 2;
  private assertField = 3;
  private assignField = 4;
  private renameField = 5;
  private unused = 6;
  action() {
    const { count, log } = this;
    const { asField } = (this as any);
    const { assertField } = (<any>this);
    let assignField, renameField;
    ({ assignField, renameField: localRename } = this);
    log();
    return count + asField + assertField + assignField + localRename;
  }
}
`);
  const declarations = analyzeUnused(file);
  assert.equal(declarations.find((d) => d.name === "count")?.used, true);
  assert.equal(declarations.find((d) => d.name === "log")?.used, true);
  assert.equal(declarations.find((d) => d.name === "asField")?.used, true);
  assert.equal(declarations.find((d) => d.name === "assertField")?.used, true);
  assert.equal(declarations.find((d) => d.name === "assignField")?.used, true);
  assert.equal(declarations.find((d) => d.name === "renameField")?.used, true);
  assert.equal(declarations.find((d) => d.name === "unused")?.used, false);
});

test("sequential loops sharing variable names resolve references to their own declaration", () => {
  const file = sourceFile(`
function forLoops() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}

function forOfLoops(arr1: number[], arr2: number[]) {
  for (const item of arr1) {
    console.log(item);
  }
  for (const item of arr2) {
    console.log(item);
  }
}

function forInLoops(obj1: Record<string, number>, obj2: Record<string, number>) {
  for (const key in obj1) {
    console.log(key);
  }
  for (const key in obj2) {
    console.log(key);
  }
}
`);
  const findings = findUnusedLocalVariable(file);
  assert.deepEqual(findings, []);
});

test("sequential loops correctly flag only unused loop variables", () => {
  const file = sourceFile(`
function testFor() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
  for (let i = 0; false; ) {
  }
}

function testForOf(arr1: number[], arr2: number[]) {
  for (const item of arr1) {
    console.log(item);
  }
  for (const item of arr2) {
  }
}

function testForIn(obj1: Record<string, number>, obj2: Record<string, number>) {
  for (const key in obj1) {
    console.log(key);
  }
  for (const key in obj2) {
  }
}
`);
  const findings = findUnusedLocalVariable(file);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].line, 6);
  assert.equal(findings[0].context, "local variable i");
  assert.equal(findings[1].line, 14);
  assert.equal(findings[1].context, "local variable item");
  assert.equal(findings[2].line, 22);
  assert.equal(findings[2].context, "local variable key");
});

test("nested loops shadowing outer loop variable isolate scopes", () => {
  const file = sourceFile(`
function nested() {
  for (let i = 0; i < 10; i++) {
    for (let i = 0; i < 5; i++) {
      console.log(i);
    }
    console.log(i);
  }
}
`);
  const findings = findUnusedLocalVariable(file);
  assert.deepEqual(findings, []);
});

test("for loops handle condition, incrementor, empty clauses, and iterable expressions", () => {
  const file = sourceFile(`
function testConditions() {
  for (let i = 0; i < 10;) {
    break;
  }
}

function testIncrementors() {
  for (let j = 0; ; j++) {
    break;
  }
}

function testEmptyFor() {
  for (;;) {
    break;
  }
}

function testOfExpression() {
  const item = [1, 2];
  for (const item of item) {
    console.log(item);
  }
}

function testInExpression() {
  const key = { a: 1 };
  for (const key in key) {
    console.log(key);
  }
}
`);
  const findings = findUnusedLocalVariable(file);
  assert.deepEqual(findings, []);
});

test("non-literal this[expr] suppresses unused private members without inventing a use", () => {
  const file = sourceFile(`
export class C {
  private secret = 1;
  private unused = 2;
  private hidden() { return 1; }
  read(key: string) {
    return this[key];
  }
}
`);
  const declarations = analyzeUnused(file);
  assert.equal(declarations.find((declaration) => declaration.name === "secret")?.used, false);
  assert.equal(declarations.find((declaration) => declaration.name === "unused")?.used, false);
  assert.equal(declarations.find((declaration) => declaration.name === "hidden")?.used, false);
  assert.deepEqual(findingNames(findUnusedPrivateField(file, declarations)), []);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file, declarations)), []);
  assert.deepEqual(findingNames(findUnusedFormalParameter(file, declarations)), []);
});

test("asserted this[key as string] suppresses unused private members for that class", () => {
  const file = sourceFile(`
export class C {
  private secret = 1;
  private unused = 2;
  private hidden() { return 1; }
  read(key: string) {
    return this[key as string];
  }
}
`);
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), []);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file)), []);
});

test("parenthesized this[(\"secret\")] counts as a use after unwrapping and does not suppress siblings", () => {
  const file = sourceFile(`
export class C {
  private secret = 1;
  private unused = 2;
  private hidden() { return 1; }
  read() {
    return this[("secret")];
  }
}
`);
  const declarations = analyzeUnused(file);
  assert.equal(declarations.find((declaration) => declaration.name === "secret")?.used, true);
  assert.deepEqual(findingNames(findUnusedPrivateField(file, declarations)), ["unused"]);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file, declarations)), ["hidden"]);
});

test("literal this[\"secret\"] counts as a use and does not suppress other unused privates", () => {
  const file = sourceFile(`
export class C {
  private secret = 1;
  private unused = 2;
  private hidden() { return 1; }
  read() {
    return this["secret"];
  }
}
`);
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), ["unused"]);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file)), ["hidden"]);
});

test("classes without dynamic this[expr] still report unused private fields and methods", () => {
  const file = sourceFile(`
export class C {
  private secret = 1;
  private unused = 2;
  private hidden() { return 1; }
  read() {
    return this.secret;
  }
}
`);
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), ["unused"]);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file)), ["hidden"]);
});

test("non-this element access does not suppress or prove unused private members", () => {
  const file = sourceFile(`
export class C {
  private leftover = 1;
  private idle() { return 1; }
  read(obj: Record<string, number>, key: string) {
    return obj[key] + obj["leftover"];
  }
}
`);
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), ["leftover"]);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file)), ["idle"]);
});

test("dynamic this[expr] only suppresses the class that contains it", () => {
  const file = sourceFile(`
export class Dynamic {
  private secret = 1;
  private hidden() { return 1; }
  read(key: string) { return this[key]; }
}
export class Static {
  private leftover = 1;
  private idle() { return 1; }
  read() { return 1; }
}
`);
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), ["leftover"]);
  assert.deepEqual(findingNames(findUnusedPrivateMethod(file)), ["idle"]);
});

test("UnusedFormalParameter ignores TypeScript this parameters", () => {
  const file = sourceFile(`
function f(this: void, x: number) {
  return x;
}
function g(this: void, x: number) {
  return 1;
}
function h(this: void, _unused: number) {
  return 1;
}
class Receiver {
  method(this: Receiver, used: number, unused: number) {
    return used;
  }
}
`);
  assert.deepEqual(findingNames(findUnusedFormalParameter(file)), ["x", "unused"]);
});

test("UnusedPrivateField sees private override constructor parameter properties", () => {
  const file = sourceFile("class C { constructor(private override x: number) {} }");
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), ["x"]);
  assert.deepEqual(findingNames(findUnusedFormalParameter(file)), []);
});

test("override-only constructor parameter properties are fields, not unused formals", () => {
  const file = sourceFile("class C { constructor(override x: number) {} }");
  assert.deepEqual(findingNames(findUnusedPrivateField(file)), []);
  assert.deepEqual(findingNames(findUnusedFormalParameter(file)), []);
});
