import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

test("nested object-literal pure calls have no effects", () => {
  assert.deepEqual(messages("nested-pure.ts", `function outer() {
  const g = { console: { log: (m: string) => m.length } };
  g.console.log("a");
  return 1;
}`), []);
});

test("nested object-literal effectful calls transfer their precise effect", () => {
  const actual = messages("nested-output.ts", `function outer() {
  const g = { console: { log: (m: string) => { console.log(m); } } };
  g.console.log("a");
  return 1;
}`);
  assert.deepEqual(actual, [
    "2:ImplicitOutput: The arrow function anonymous() uses console, an implicit output.",
    "3:ImplicitOutput: The function outer() uses console, an implicit output.",
  ]);
});

for (const [name, source] of [
  ["globalthis-console", `function outer() {
  const g = { console: { log: (m: string) => m.length } };
  const globalThis = g;
  globalThis.console.log("a");
}`],
  ["window-console", `function outer() {
  const g = { console: { log: (m: string) => m.length } };
  const window = g;
  window.console.log("a");
}`],
  ["globalthis-date", `function outer() {
  const g = { Date: { now: () => 1 } };
  const globalThis = g;
  return globalThis.Date.now();
}`],
  ["module-globalthis-date", `const g = { Date: { now: () => 1 } };
function outer() {
  const globalThis = g;
  return globalThis.Date.now();
}`],
  ["static-element", `function outer() {
  const g = { nested: { fn: () => 1 } };
  return g["nested"]["fn"]();
}`],
  ["numeric-element", `function outer() {
  const g = { nested: { 0: () => 1 } };
  return g.nested[0]();
}`],
  ["deeper-path", `function outer() {
  const g = { a: { b: { fn: () => 1 } } };
  return g.a.b.fn();
}`],
]) {
  test(`nested object-literal calls stay pure through ${name}`, () => {
    assert.deepEqual(messages(`${name}.ts`, source), []);
  });
}

test("a parameter-computed member call preserves known output and uncertainty", () => {
  assert.deepEqual(messages("nested-computed-output.ts", `function outer(key: string) {
  const g = { nested: { fn: () => { console.log("a"); } } };
  g.nested[key]();
}`), [
    "2:ImplicitOutput: The arrow function anonymous() uses console, an implicit output.",
    "3:ImplicitOutput: The function outer() uses console, an implicit output.",
    "3:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
});

test("a parameter-computed member call remains unknown", () => {
  assert.deepEqual(messages("nested-computed.ts", `function outer(key: string) {
  const g = { nested: { fn: () => 1 } };
  return g.nested[key]();
}`), [
    "3:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
});
