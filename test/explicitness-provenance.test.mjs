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

test("a closure that returns its captured array exposes it to the reads beside it", () => {
  const source = [
    "function outer() {",
    "  const values = [0, 1];",
    "  const bump = () => { values[1] = 5; };",
    "  const expose = () => values;",
    "  const head = () => values[0];",
    "  return { bump, expose, head };",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(ownerMessages("head", "escape-alias.ts", source), [
    "5:ImplicitInput: The arrow function head() reads values, an implicit input.",
  ]);
});

test("a closure that returns one element keeps the other captured slots private", () => {
  const source = [
    "function outer() {",
    "  const values = [0, 1];",
    "  const read = () => values[1] ?? -1;",
    "  const add = () => values.slice().length;",
    "  return { add, read };",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(messages("escape-element.ts", source), []);
});

for (const [name, copy] of [["spread", "[...rows]"], ["slice", "rows.slice()"]]) {
  test(`sorting a ${name} copy reads the elements another function mutates`, () => {
    const source = [
      "const rows: number[][] = [[1], [2]];",
      "export function bump() { rows[0].push(1); }",
      "export function order() {",
      `  const copy = ${copy};`,
      "  copy.sort((left, right) => left.length - right.length);",
      "  return copy;",
      "}",
      "",
    ].join("\n");
    assert.equal(ownerMessages("order", `sort-${name}.ts`, source).length, 1);
  });
}

test("iterating a spread copy reads the elements another function mutates", () => {
  const source = [
    "const rows: number[][] = [[1], [2]];",
    "export function bump() { rows[0].push(1); }",
    "export function order() {",
    "  let total = 0;",
    "  for (const row of [...rows]) total += row.length;",
    "  return total;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(ownerMessages("order", "copy-loop.ts", source), [
    "5:ImplicitInput: The function order() reads rows, an implicit input.",
  ]);
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

test("re-aliasing a console alias without calling it is quiet", () => {
  const source = ["const out = console;", "function outer() {", "  const log = out;", "  return 1;", "}", ""];
  assert.deepEqual(ownerMessages("outer", "console-realias.ts", source.join("\n")), []);
});

test("a let initialized with console is not a constant alias of the sink", () => {
  const source = ["let out = console;", "function outer() {", "  out.log(\"x\");", "}", ""];
  assert.deepEqual(ownerMessages("outer", "console-let.ts", source.join("\n")), [
    "3:UnknownEffect: The function outer() calls unresolved callable, an unknown effect.",
  ]);
});

test("a constant alias of document is written by member writes and read by member reads", () => {
  const source = ["const doc = document;", "function writer() {", "  doc.title = \"x\";", "}", "function reader() {", "  return doc.title;", "}", ""];
  assert.deepEqual(messages("document-alias.ts", source.join("\n")), [
    "1:ImplicitInput: The module reads document, an implicit input.",
    "3:ImplicitOutput: The function writer() writes document, an implicit output.",
    "6:ImplicitInput: The function reader() reads document, an implicit input.",
  ]);
});

const generatorUse = (lines) => [...generator, "function outer() {", "  const it = gen();", ...lines, "}", ""].join("\n");

test("passing a generator's next method to a fresh library call does not run the body", () => {
  assert.deepEqual(ownerMessages("outer", "next-string.ts", generatorUse(["  return String(it.next);"])), []);
});

test("using a generator as a computed key does not run the body", () => {
  const lines = ["  const table: Record<string, number> = {};", "  return typeof table[it as any];"];
  assert.deepEqual(ownerMessages("outer", "generator-key.ts", generatorUse(lines)), []);
});

test("a generator escaping into a library result transfers its effects to the escape", () => {
  const concat = ["  const xs = ([] as Generator<number>[]).concat(it);", "  return [...xs[0]];"];
  assert.deepEqual(ownerMessages("outer", "escape-concat.ts", generatorUse(concat)), [
    "8:ImplicitOutput: The function outer() writes log, an implicit output.",
    "9:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
  ]);
  const assign = ["  const box: { g?: Generator<number> } = {};", "  Object.assign(box, { g: it });", "  return [...box.g!];"];
  assert.deepEqual(ownerMessages("outer", "escape-assign.ts", generatorUse(assign)), [
    "9:ImplicitOutput: The function outer() writes log, an implicit output.",
    "10:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
  ]);
  const holder = [...generator, "function outer() {", "  const box: { g?: Generator<number> } = {};", "  Object.assign(box, { g: gen() });", "  return [...box.g!];", "}", ""];
  assert.deepEqual(ownerMessages("outer", "escape-assign-holder.ts", holder.join("\n")), [
    "8:ImplicitOutput: The function outer() writes log, an implicit output.",
    "9:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
  ]);
  const replacer = ["  return JSON.stringify(it, (key, value) => (value && typeof value.next === \"function\" ? value.next().value : value));"];
  assert.deepEqual(ownerMessages("outer", "escape-json.ts", generatorUse(replacer)), [
    "8:UnknownEffect: The function outer() calls unresolved callable, an unknown effect.",
    "8:ImplicitOutput: The function outer() writes log, an implicit output.",
  ]);
  const all = [...generator, "async function outer() {", "  const [x] = await Promise.all([gen()]);", "  return [...x];", "}", ""];
  assert.deepEqual(ownerMessages("outer", "escape-all.ts", all.join("\n")), [
    "7:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
    "7:ImplicitOutput: The function outer() writes log, an implicit output.",
  ]);
});

test("a call's returned literal resolves methods through arrow bodies, exported functions and nested branches but not nested functions", () => {
  const source = [
    "const arrow = () => ({ emit(): void { console.log(\"a\"); } });",
    "export function branch(flag: boolean) {",
    "  if (flag) {",
    "    return { emit(): void { console.log(\"b\"); } };",
    "  }",
    "  return { emit(): void {} };",
    "}",
    "function nested() {",
    "  const helper = (p: any) => { return p; };",
    "  class Holder { get(p: any) { return p; } }",
    "  return { emit(): void {}, helper, Holder };",
    "}",
    "function useArrow() { arrow().emit(); }",
    "function useBranch() { branch(true).emit(); }",
    "function useNested() { nested().emit(); }",
    "",
  ];
  assert.deepEqual(messages("returned-literal.ts", source.join("\n")), [
    "1:ImplicitOutput: The method emit() uses console, an implicit output.",
    "4:ImplicitOutput: The method emit() uses console, an implicit output.",
    "13:ImplicitOutput: The function useArrow() uses console, an implicit output.",
    "14:ImplicitOutput: The function useBranch() uses console, an implicit output.",
  ]);
});

test("generator, async, empty and partly unresolved returns leave method calls unresolved", () => {
  const source = [
    "function* gen() { return { emit(): void {} }; }",
    "async function later() { return { emit(): void {} }; }",
    "const lazy = async () => ({ emit(): void {} });",
    "function none(): any { }",
    "const nothing: any = null;",
    "function partial(p: any) {",
    "  if (p) {",
    "    return p;",
    "  }",
    "  return { emit(): void {} };",
    "}",
    "function useGen() { (gen() as any).emit(); }",
    "function useLater() { (later() as any).emit(); }",
    "function useLazy() { (lazy() as any).emit(); }",
    "function useNone() { none().emit(); }",
    "function useNothing() { nothing().emit(); }",
    "function usePartial(p: any) { partial(p).emit(); }",
    "",
  ];
  assert.deepEqual(messages("returned-unresolved.ts", source.join("\n")), [
    "12:UnknownEffect: The function useGen() calls overridable method, an unknown effect.",
    "13:UnknownEffect: The function useLater() calls overridable method, an unknown effect.",
    "14:UnknownEffect: The function useLazy() calls overridable method, an unknown effect.",
    "15:UnknownEffect: The function useNone() calls overridable method, an unknown effect.",
    "16:UnknownEffect: The function useNothing() calls overridable method, an unknown effect.",
    "17:UnknownEffect: The function usePartial() calls overridable method, an unknown effect.",
  ]);
});
