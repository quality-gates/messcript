import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const overloads = require("../dist/ast/overloads.js");
const { getClassMethods } = require("../dist/ast/classes.js");

function parse(source) {
  return ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

test("retains the same representatives and order for class members", () => {
  const file = parse(`
class Example {
  constructor(x: number);
  constructor(x: string);
  constructor(x: unknown) {}
  first(x: number): void;
  "first"(x: string): void;
  first(x: unknown) {}
  static first(x: number): void;
  static "first"(x: string): void;
  get value() { return 1; }
  set value(x: number) {}
  orphan(x: number): void;
  orphan(x: string): void;
  last() {}
}`);
  const methods = getClassMethods(file.statements[0]);
  assert.deepEqual(methods.map((method) => method.getText(file)), [
    "constructor(x: unknown) {}",
    "first(x: unknown) {}",
    'static "first"(x: string): void;',
    "get value() { return 1; }",
    "set value(x: number) {}",
    "orphan(x: string): void;",
    "last() {}",
  ]);
});

test("distinct ambient methods require linear overload key work", () => {
  const original = overloads.classMethodKey;
  let calls = 0;
  overloads.classMethodKey = (...args) => {
    calls++;
    return original(...args);
  };
  try {
    for (const count of [20, 40, 80]) {
      const declarations = Array.from({ length: count }, (_, i) => `method${i}(): void;`).join("\n");
      const file = parse(`declare class Api { ${declarations} }`);
      calls = 0;
      const methods = getClassMethods(file.statements[0]);
      assert.deepEqual(methods.map((method) => method.name.text),
        Array.from({ length: count }, (_, i) => `method${i}`));
      assert.ok(calls <= count * 2, `${count} methods required ${calls} key calls`);
    }
  } finally {
    overloads.classMethodKey = original;
  }
});
