import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

const ownerMessages = (owner, name, source) => messages(name, source).filter((message) => message.includes(`${owner}()`));

test("a closure that returns a shallow copy keeps captured slots private", () => {
  const source = [
    "function outer() {",
    "  const values = [0, 1];",
    "  const bump = () => { values[1] = 5; };",
    "  const expose = () => [...values];",
    "  const head = () => values[0];",
    "  return { bump, expose, head };",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(ownerMessages("head", "escape-copy.ts", source), []);
});

const generator = [
  "const log: number[] = [];",
  "function* gen() {",
  "  log.push(1);",
  "  yield 1;",
  "}",
];

test("reading a generator's next method without calling it does not run the body", () => {
  const source = [...generator, "function outer() {", "  const it = gen();", "  return typeof it.next;", "}", ""].join("\n");
  assert.deepEqual(messages("next-read.ts", source), [
    "3:ImplicitOutput: The function gen() writes log, an implicit output.",
  ]);
});

test("storing generators in a private array is quiet and iterating an element transfers there", () => {
  const store = [
    ...generator,
    "function outer() {",
    "  const its: Generator<number>[] = [];",
    "  for (let k = 0; k < 2; k += 1) {",
    "    its.push(gen());",
    "  }",
  ];
  assert.deepEqual(ownerMessages("outer", "stored-create.ts", [...store, "  return its.length;", "}", ""].join("\n")), []);
  const iterate = [...store, "  let n = 0;", "  for (const v of its[1]) {", "    n += v;", "  }", "  return n;", "}", ""];
  assert.deepEqual(ownerMessages("outer", "stored-iterate.ts", iterate.join("\n")), [
    "12:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
  ]);
});

const counterFactory = (cell) => [
  ...(cell === "module" ? ["let n = 0;"] : []),
  "function make() {",
  ...(cell === "module" ? [] : ["  let n = 0;"]),
  "  const inc = () => {",
  "    n += 1;",
  "  };",
  "  const get = () => {",
  "    return n;",
  "  };",
  "  return { inc, get };",
  "}",
  "function outer() {",
  "  const c = make();",
  "  c.inc();",
  "  return c.get();",
  "}",
  "",
].join("\n");

test("methods of an object a factory returns resolve at the invocation and carry module effects there", () => {
  assert.deepEqual(ownerMessages("outer", "factory-module.ts", counterFactory("module")), [
    "13:ImplicitInput: The function outer() reads n, an implicit input.",
    "13:ImplicitOutput: The function outer() writes n, an implicit output.",
  ]);
});

test("methods of an object a factory returns touch a fresh captured cell per factory call", () => {
  assert.deepEqual(ownerMessages("outer", "factory-local.ts", counterFactory("local")), []);
});

const boxFactory = [
  "function make() {",
  "  const local: number[] = [];",
  "  return {",
  "    add() {",
  "      local.push(1);",
  "    },",
  "    size() {",
  "      return local.length;",
  "    },",
  "  };",
  "}",
];

test("a factory box held by the module shares its captured storage across calls", () => {
  const source = [...boxFactory, "const box = make();", "function outer() {", "  box.add();", "  return box.size();", "}", ""];
  assert.deepEqual(ownerMessages("outer", "box-module.ts", source.join("\n")), [
    "14:ImplicitOutput: The function outer() writes local, an implicit output.",
    "15:ImplicitInput: The function outer() reads local, an implicit input.",
  ]);
});

test("a factory box created per call keeps its captured storage private", () => {
  const source = [...boxFactory, "function outer() {", "  const box = make();", "  box.add();", "  return box.size();", "}", ""];
  assert.deepEqual(ownerMessages("outer", "box-local.ts", source.join("\n")), []);
});

const wrapFactory = ["function wrap(xs: number[]) {", "  return () => xs;", "}"];

test("a closure returning a factory parameter returns the factory call's argument", () => {
  const source = [...wrapFactory, "function outer(xs: number[]) {", "  const get = wrap([]);", "  get().push(1);", "  return xs.length;", "}", ""];
  assert.deepEqual(ownerMessages("outer", "wrap-fresh.ts", source.join("\n")), []);
});

test("a closure returning a factory parameter still writes through a shared argument", () => {
  const source = [...wrapFactory, "const shared: number[] = [];", "function outer() {", "  const get = wrap(shared);", "  get().push(1);", "}", ""];
  assert.deepEqual(ownerMessages("outer", "wrap-shared.ts", source.join("\n")), [
    "6:ImplicitInput: The function outer() reads shared, an implicit input.",
    "7:ImplicitOutput: The function outer() mutates receiver of push, an implicit output.",
  ]);
});

test("a constant alias of console keeps the sink at the call through the alias", () => {
  const source = ["const out = console;", "const log = out;", "function outer() {", "  out.log(\"x\");", "  log.warn(\"y\");", "}", ""];
  assert.deepEqual(ownerMessages("outer", "console-alias.ts", source.join("\n")), [
    "4:ImplicitOutput: The function outer() uses console, an implicit output.",
  ]);
});

test("a constant alias of a same-file logger is not a host sink", () => {
  const source = ["const sink = { log(m: string) { return m.length; } };", "const out = sink;", "function outer() {", "  return out.log(\"x\");", "}", ""];
  assert.deepEqual(ownerMessages("outer", "local-alias.ts", source.join("\n")), []);
});
