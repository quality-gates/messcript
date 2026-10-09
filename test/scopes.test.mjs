import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { analyzeScopes } from "../dist/ast/scopes.js";

function sourceFile(source) {
  return ts.createSourceFile("scopes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function identifiers(file, text) {
  const found = [];
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === text) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

// Gives the line of each declaration of the binding that the occurrence resolves to.
function resolvedLines(file, text, occurrence) {
  const binding = analyzeScopes(file).resolve(identifiers(file, text)[occurrence]);
  return binding?.declarations.map((declaration) => file.getLineAndCharacterOfPosition(declaration.identifier.getStart()).line);
}

test("a block declaration shadows an outer declaration only inside the block", () => {
  const file = sourceFile(`const x = 1;
{
  const x = 2;
  x;
}
x;
`);

  assert.deepEqual(resolvedLines(file, "x", 2), [2]);
  assert.deepEqual(resolvedLines(file, "x", 3), [0]);
});

function bindingNamed(file, name) {
  return analyzeScopes(file).bindings.find((binding) => binding.name === name);
}

test("a var declaration belongs to the enclosing function and joins earlier declarations of the same name", () => {
  const file = sourceFile(`function hoist() {
  {
    var v = 1;
  }
  v;
  var v;
}
v;
`);

  assert.deepEqual(resolvedLines(file, "v", 1), [2, 5]);
  assert.equal(bindingNamed(file, "v").scope.kind, "function");
  assert.equal(resolvedLines(file, "v", 3), undefined);
});

test("a let declaration in a case clause stays inside the switch", () => {
  const file = sourceFile(`switch (input) {
  case 1:
    let y = 1;
    y;
}
y;
`);

  assert.deepEqual(resolvedLines(file, "y", 1), [2]);
  assert.equal(resolvedLines(file, "y", 2), undefined);
});

test("a var declaration in a namespace belongs to the namespace", () => {
  const file = sourceFile(`namespace Space {
  { var n = 1; }
}
n;
`);

  assert.equal(bindingNamed(file, "n").scope.kind, "namespace");
  assert.equal(resolvedLines(file, "n", 1), undefined);
});

test("a var declaration in a class static block stays inside the block", () => {
  const file = sourceFile(`class Holder {
  static {
    var s = 1;
  }
}
s;
`);

  assert.equal(bindingNamed(file, "s").scope.kind, "function");
  assert.equal(resolvedLines(file, "s", 1), undefined);
});

test("a closure resolves outer parameters and its own parameters shadow them", () => {
  const file = sourceFile(`function outer(a, b) {
  return (b) => a + b;
}
`);

  assert.deepEqual(resolvedLines(file, "a", 1), [0]);
  assert.deepEqual(resolvedLines(file, "b", 2), [1]);
  assert.equal(bindingNamed(file, "a").declarations[0].kind, "parameter");
  assert.ok(ts.isParameter(bindingNamed(file, "a").declarations[0].node));
});

test("a constructor parameter property is a parameter binding that later parameter defaults resolve", () => {
  const file = sourceFile(`class Account {
  constructor(private readonly owner: string, label = owner) {}
}
`);
  const owner = bindingNamed(file, "owner");

  assert.equal(owner.declarations[0].kind, "parameter");
  assert.equal(owner.scope.kind, "function");
  assert.deepEqual(owner.references.map((reference) => reference.parent.kind), [ts.SyntaxKind.Parameter]);
});

test("destructuring binds each element name but not the property names or computed keys", () => {
  const file = sourceFile(`const key = "k";
const { a, b: [c, ...d], [key]: e = a } = source;
`);
  const names = analyzeScopes(file).bindings.map((binding) => binding.name);

  assert.deepEqual(names, ["key", "a", "c", "d", "e"]);
  assert.deepEqual(resolvedLines(file, "key", 1), [0]);
  assert.deepEqual(resolvedLines(file, "a", 1), [1]);
  assert.equal(analyzeScopes(file).isReference(identifiers(file, "b")[0]), false);
});

test("a catch clause binding is visible only in the catch block", () => {
  const file = sourceFile(`try {
} catch (error) {
  error;
}
error;
`);

  assert.deepEqual(resolvedLines(file, "error", 1), [1]);
  assert.equal(resolvedLines(file, "error", 2), undefined);
});

test("a named function expression or class expression binds its name only inside itself", () => {
  const file = sourceFile(`const run = function again() { again; };
again;
const Made = class Inner { make() { return Inner; } };
Inner;
`);

  assert.deepEqual(resolvedLines(file, "again", 1), [0]);
  assert.equal(resolvedLines(file, "again", 2), undefined);
  assert.deepEqual(resolvedLines(file, "Inner", 1), [2]);
  assert.equal(resolvedLines(file, "Inner", 2), undefined);
});

test("declarations of functions, classes, enums, and imports belong to the enclosing block", () => {
  const file = sourceFile(`import Default, { named as alias } from "m";
import * as all from "m";
import legacy = require("m");
{
  function helper() {}
  class Shape {}
  enum Color { Red }
}
helper;
`);
  const kinds = Object.fromEntries(analyzeScopes(file).bindings.map((binding) => [binding.name, binding.declarations[0].kind]));

  assert.deepEqual(kinds, {
    Default: "import", alias: "import", all: "import", legacy: "import", helper: "function", Shape: "class", Color: "enum",
  });
  assert.equal(bindingNamed(file, "Shape").scope.kind, "block");
  assert.equal(resolvedLines(file, "helper", 1), undefined);
});

test("a for-of expression resolves outside the loop bindings", () => {
  const file = sourceFile(`const items = [];
for (const items of items) {
  items;
}
`);

  assert.deepEqual(resolvedLines(file, "items", 2), [0]);
  assert.deepEqual(resolvedLines(file, "items", 3), [1]);
});

test("names, property names, labels, and qualified name parts are not references", () => {
  const file = sourceFile(`const value = 1;
const local = 2;
type T = Space.value;
const object = { value: value, local };
object.value;
label: for (;;) { break label; }
export { local as value };
`);
  const model = analyzeScopes(file);
  const references = (text) => identifiers(file, text).map((identifier) => model.isReference(identifier));

  assert.deepEqual(references("value"), [false, false, false, true, false, false]);
  assert.deepEqual(references("local"), [false, true, true]);
  assert.deepEqual(references("label"), [false, false]);
  assert.deepEqual(references("Space"), [true]);
  assert.equal(bindingNamed(file, "local").references.length, 2);
});

test("a shorthand property assignment reads its name and its default value", () => {
  const file = sourceFile(`const fallback = 1;
let a;
({ a = fallback } = source);
`);

  assert.deepEqual(resolvedLines(file, "a", 1), [1]);
  assert.deepEqual(resolvedLines(file, "fallback", 1), [0]);
});

test("JSX tag names are references and JSX attribute names are not", () => {
  const file = sourceFile(`const Widget = () => null;
const size = 1;
const view = <Widget size={size} />;
`);
  const model = analyzeScopes(file);

  assert.deepEqual(identifiers(file, "Widget").map((identifier) => model.isReference(identifier)), [false, true]);
  assert.deepEqual(identifiers(file, "size").map((identifier) => model.isReference(identifier)), [false, false, true]);
});

test("writes are classified at the root of the write target", () => {
  const file = sourceFile(`let plain = 0;
let counter = 0;
const box = { inner: {} };
const list = [];
plain = 1;
counter += 1;
box.inner.value = 2;
make().field = 3;
list.push(4);
(list as number[])["sort"]();
Object.assign(box, {});
[plain, ...list] = [];
({ plain } = {});
delete box.inner;
`);
  const model = analyzeScopes(file);
  const writes = (text) => identifiers(file, text).map((identifier) => model.writeOf(identifier) ?? null);

  assert.deepEqual(writes("plain"), [null, { viaCall: false, reassign: true, compound: false }, { viaCall: false, reassign: true, compound: false }, { viaCall: false, reassign: true, compound: false }]);
  assert.deepEqual(writes("counter"), [null, { viaCall: false, reassign: true, compound: true }]);
  assert.deepEqual(writes("box"), [null, { viaCall: false, reassign: false, compound: false }, { viaCall: false, reassign: false, compound: false }, { viaCall: false, reassign: false, compound: false }]);
  assert.deepEqual(writes("make"), [{ viaCall: true, reassign: false, compound: false }]);
  assert.deepEqual(writes("list"), [null, { viaCall: false, reassign: false, compound: false }, { viaCall: false, reassign: false, compound: false }, { viaCall: false, reassign: true, compound: false }]);
});

test("writes to this are classified", () => {
  const file = sourceFile(`class Counter {
  count = 0;
  bump() { this.count++; this.read(); }
}
`);
  const model = analyzeScopes(file);
  const thisNodes = [];
  (function visit(node) {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      thisNodes.push(node);
    }
    ts.forEachChild(node, visit);
  })(file);

  assert.deepEqual(thisNodes.map((node) => model.writeOf(node) ?? null), [{ viaCall: false, reassign: false, compound: true }, null]);
});

test("a binding is mutated by a direct write or a mutating method call but not by a read or a call result write", () => {
  const file = sourceFile(`let reassigned = 0;
const pushed = [];
const read = [];
const factory = () => ({});
const forIn = {};
let target;
reassigned = 1;
pushed.push(1);
read.map(String);
factory().value = 1;
for (target in forIn) {}
`);
  const mutated = Object.fromEntries(analyzeScopes(file).bindings.map((binding) => [binding.name, binding.mutated]));

  assert.deepEqual(mutated, { reassigned: true, pushed: true, read: false, factory: false, forIn: false, target: true });
});

test("the update clause of a for loop does not mutate the per-iteration binding", () => {
  const file = sourceFile(`for (let i = 0; i < 3; i++) {}
for (let j = 0; j < 3; j++) { j = 5; }
for (let k = 0; k < 3; (() => k++)()) {}
for (var v = 0; v < 3; v++) {}
`);
  const mutated = Object.fromEntries(analyzeScopes(file).bindings.map((binding) => [binding.name, binding.mutated]));

  assert.deepEqual(mutated, { i: false, j: true, k: true, v: true });
});

test("analyzeScopes caches the model per source file", () => {
  const file = sourceFile("const a = 1;");

  assert.equal(analyzeScopes(file), analyzeScopes(file));
  assert.notEqual(analyzeScopes(file), analyzeScopes(sourceFile("const a = 1;")));
});
