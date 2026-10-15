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
    "12:ImplicitOutput: The function outer() writes log, an implicit output.",
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

test("a generator stored through a library result transfers its effects when consumed", () => {
  const concat = ["  const xs = ([] as Generator<number>[]).concat(it);", "  return [...xs[0]];"];
  assert.deepEqual(ownerMessages("outer", "escape-concat.ts", generatorUse(concat)), [
    "9:ImplicitOutput: The function outer() writes log, an implicit output.",
  ]);
  const assign = ["  const box: { g?: Generator<number> } = {};", "  Object.assign(box, { g: it });", "  return [...box.g!];"];
  assert.deepEqual(ownerMessages("outer", "escape-assign.ts", generatorUse(assign)), [
    "10:ImplicitOutput: The function outer() writes log, an implicit output.",
  ]);
  const holder = [...generator, "function outer() {", "  const box: { g?: Generator<number> } = {};", "  Object.assign(box, { g: gen() });", "  return [...box.g!];", "}", ""];
  assert.deepEqual(ownerMessages("outer", "escape-assign-holder.ts", holder.join("\n")), [
    "9:ImplicitOutput: The function outer() writes log, an implicit output.",
  ]);
  const replacer = ["  return JSON.stringify(it, (key, value) => (value && typeof value.next === \"function\" ? value.next().value : value));"];
  assert.deepEqual(ownerMessages("outer", "escape-json.ts", generatorUse(replacer)), [
    "8:ImplicitOutput: The function outer() writes log, an implicit output.",
    "8:UnknownEffect: The function outer() calls unresolved callable, an unknown effect.",
  ]);
  const all = [...generator, "async function outer() {", "  const [x] = await Promise.all([gen()]);", "  return [...x];", "}", ""];
  assert.deepEqual(ownerMessages("outer", "escape-all.ts", all.join("\n")), [
    "7:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
    "8:ImplicitOutput: The function outer() writes log, an implicit output.",
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


test("a spread preserves earlier array positions and shared reads after its insertion", () => {
  assert.deepEqual(messages("spread-prefix-stable.ts", `const shared = [1];
function bump() { shared[0] = 2; }
function run(rest: number[][]) { return [shared, [], ...rest][1][0]; }
`), [
    "2:ImplicitOutput: The function bump() writes shared, an implicit output.",
  ]);
  assert.deepEqual(messages("spread-suffix-stable.ts", `const shared = [1];
function bump() { shared[0] = 2; }
function run(rest: number[][]) { return [[], ...rest, shared][0][0]; }
`), [
    "2:ImplicitOutput: The function bump() writes shared, an implicit output.",
  ]);
  assert.deepEqual(messages("spread-suffix-shared.ts", `const shared = [1];
function bump() { shared[0] = 2; }
function run(rest: number[][]) { return [[], ...rest, shared][1][0]; }
`), [
    "2:ImplicitOutput: The function bump() writes shared, an implicit output.",
    "3:ImplicitInput: The function run() reads shared, an implicit input.",
  ]);
});


test("a closure reads nested shared elements retained by a shallow copy", () => {
  assert.deepEqual(messages("captured-copy-read.ts", `const rows: number[][] = [[1]];
export function bump() { rows[0][0] = 2; }
export function outer() {
  const copy = [...rows];
  const inner = () => copy[0][0];
  return inner();
}
`), [
    "2:ImplicitOutput: The function bump() writes rows, an implicit output.",
    "5:ImplicitInput: The arrow function inner() reads rows, an implicit input.",
    "6:ImplicitInput: The function outer() reads rows, an implicit input.",
  ]);
});

test("captured mutators read existing slots while append only retains references", () => {
  const source = `function outer() {
  const values = [0, 7];
  function change() { values.pop(); }
  function append() { values.push(9); }
  function read() { return values[1] ?? -1; }
  change(); append();
  return read();
}
`;
  assert.deepEqual(ownerMessages("change", "captured-mutator-read.ts", source), [
    "3:ImplicitInput: The function change() reads values, an implicit input.",
    "3:ImplicitOutput: The function change() writes values, an implicit output.",
  ]);
  assert.deepEqual(ownerMessages("append", "captured-append.ts", source), [
    "4:ImplicitOutput: The function append() writes values, an implicit output.",
  ]);
});

test("a callback read survives alongside uncertainty in its argument ownership", () => {
  const source = `const state = { count: 0 };
function save() {
  return JSON.stringify(state, (key, value) => { if (key === "") { value.count += 1; } return value; });
}
`;
  assert.deepEqual(messages("callback-read-with-unknown.ts", source).filter(message => message.includes("ImplicitInput")), [
    "3:ImplicitInput: The function save() reads state, an implicit input.",
  ]);
});


test("increment and decrement invoke both accessor bodies", () => {
  for (const operation of ["c.value++", "--c.value"]) {
    assert.deepEqual(messages("accessor-update.ts", `const log: number[] = [];
class Counter {
  get value() { return log.length; }
  set value(next: number) { log.push(next); }
}
function run() {
  const c = new Counter();
  ${operation};
}
`), [
      "3:ImplicitInput: The accessor Counter.value() reads log, an implicit input.",
      "4:ImplicitOutput: The accessor Counter.value() writes log, an implicit output.",
      "8:ImplicitInput: The function run() reads log, an implicit input.",
      "8:ImplicitOutput: The function run() writes log, an implicit output.",
    ]);
  }
});


test("short circuit assignments retain every reachable storage alternative", () => {
  for (const statement of ["flag && (target = [])", "flag || (target = [])", "flag ?? (target = [])"]) {
    assert.deepEqual(messages("short-circuit-retains.ts", `const store: number[] = [];
function fill(flag: boolean | undefined) {
  let target = store;
  ${statement};
  target.push(1);
}
`), ["5:ImplicitOutput: The function fill() mutates caller-owned value target, an implicit output."]);
  }
  for (const operator of ["||=", "&&=", "??="]) {
    assert.deepEqual(messages("logical-assignment-joins.ts", `const store: number[] = [];
function fill(start: number[] | undefined) {
  let target = start;
  target ${operator} store;
  target!.push(1);
}
`), ["5:ImplicitOutput: The function fill() mutates caller-owned value target, an implicit output."]);
  }
});


test("imports and declared class members retain their external reads", () => {
  assert.deepEqual(messages("imported-host-name.ts", `import { console } from "./sink";
export function change() { console.log(1); }
`), [
    "2:ImplicitInput: The function change() reads console, an implicit input.",
    "2:UnknownEffect: The function change() calls unresolved callable, an unknown effect.",
  ]);
  assert.deepEqual(messages("declared-class-method.ts", `declare class Registry { static reset(): void; }
function reset() { Registry.reset(); }
`), [
    "2:ImplicitInput: The function reset() reads Registry, an implicit input.",
    "2:UnknownEffect: The function reset() calls unresolved callable, an unknown effect.",
  ]);
});

test("an unresolved call keeps a mutable argument read on its own line", () => {
  assert.deepEqual(messages("multiline-unknown-read.ts", `const log: number[] = [];
function touch() { log.push(1); }
function run(make: (value: unknown) => void) {
  make(
    log,
  );
}
`), [
    "2:ImplicitOutput: The function touch() writes log, an implicit output.",
    "4:UnknownEffect: The function run() calls unresolved callable, an unknown effect.",
    "5:ImplicitInput: The function run() reads log, an implicit input.",
  ]);
});

test("string storage consumes an array's contents when converting its value", () => {
  assert.deepEqual(messages("storage-string-input.ts", `const items: number[] = [1];
function grow() { items.push(2); }
function save() { localStorage.setItem("items", items as unknown as string); }
`), [
    "2:ImplicitOutput: The function grow() writes items, an implicit output.",
    "3:ImplicitOutput: The function save() writes localStorage, an implicit output.",
    "3:ImplicitInput: The function save() reads items, an implicit input.",
  ]);
});


test("adding a distinct map key retains the previously stored shared key", () => {
  assert.deepEqual(messages("map-key-join.ts", `const shared = [1];
function bump() { shared[0] = 2; }
function outer() {
  const m = new Map<number[], number>();
  m.set(shared, 1);
  m.set([0], 2);
  let total = 0;
  for (const key of m.keys()) total += key[0];
  return total;
}
`), [
    "2:ImplicitOutput: The function bump() writes shared, an implicit output.",
    "8:ImplicitInput: The function outer() reads shared, an implicit input.",
  ]);
});


test("a supplied append callback does not read the forwarded array's contents", () => {
  const source = `const store: number[] = [];
function run(callback: (values: number[]) => void) {
  callback(store);
}
function caller() {
  run((values) => { values.push(1); });
}
`;
  assert.deepEqual(messages("supplied-append-callback.ts", source).filter(message => message.includes("ImplicitInput")), []);
  assert.deepEqual(ownerMessages("caller", "supplied-append-callback.ts", source), [
    "6:ImplicitOutput: The function caller() mutates caller-owned callback argument, an implicit output.",
  ]);
});


test("a helper result retains a selected shared map value", () => {
  const source = `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function pick(m: Map<string, number[]>) { return m.get("a")!; }
function outer() {
  const m = new Map([["a", shared]]);
  return pick(m)[0];
}
`;
  assert.deepEqual(ownerMessages("outer", "helper-map-result.ts", source), [
    "6:ImplicitInput: The function outer() reads shared, an implicit input.",
  ]);
  assert.deepEqual(ownerMessages("outer", "helper-map-result-quiet.ts", source.replace("function bump() { shared[0] = 2; }", "function bump() { return 2; }")), []);
});


test("an unresolved collection callback retains a shared element read", () => {
  const source = `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function outer(callback: (value: number[]) => void) {
  const held = [shared];
  held.forEach(callback);
}
function caller() { outer((value) => { value.push(1); }); }
`;
  assert.deepEqual(ownerMessages("outer", "unknown-element-callback.ts", source), [
    "5:ImplicitInput: The function outer() reads shared, an implicit input.",
    "5:UnknownEffect: The function outer() calls unresolved callable, an unknown effect.",
  ]);
  assert.deepEqual(ownerMessages("caller", "unknown-element-callback.ts", source).filter(message => message.includes("ImplicitInput")), []);
});


test("for-of rebinding assigns the iterated storage before running its body", () => {
  for (const initializer of ["target", "const target"]) {
    const source = `const store: number[] = [];
function fill() {
  let target: number[] = [];
  for (${initializer} of [store]) {
    target.push(1);
  }
}
`;
    assert.deepEqual(ownerMessages("fill", "forof-rebinding.ts", source), [
      "5:ImplicitOutput: The function fill() mutates caller-owned value target, an implicit output.",
    ]);
    assert.deepEqual(ownerMessages("fill", "forof-rebinding-private.ts", source.replace("of [store]", "of [[]]")), []);
  }
});


test("binding a known function defers its effects until the bound call", () => {
  const source = `let total = 0;
function add(value: number) { total += value; return total; }
function bindOnly() { return add.bind(undefined, 2); }
function outer() {
  const bound = add.bind(undefined, 2);
  return bound();
}
`;
  assert.deepEqual(ownerMessages("bindOnly", "known-bound-source.ts", source), []);
  assert.deepEqual(ownerMessages("outer", "known-bound-source.ts", source), [
    "6:ImplicitInput: The function outer() reads total, an implicit input.",
    "6:ImplicitOutput: The function outer() writes total, an implicit output.",
  ]);
});


test("a bound generator step advances its captured iterator", () => {
  const source = `function outer() {
  const values = [0];
  function* gen() { values.push(1); yield 1; }
  function read0() { return values[0]; }
  function read1() { return values[1]; }
  const it = gen();
  const step = it.next.bind(it);
  step();
  return [read0(), read1()];
}
`;
  assert.deepEqual(ownerMessages("read0", "bound-generator-step.ts", source), []);
  assert.deepEqual(ownerMessages("read1", "bound-generator-step.ts", source), [
    "5:ImplicitInput: The function read1() reads values, an implicit input.",
  ]);
  assert.deepEqual(ownerMessages("outer", "bound-generator-step.ts", source), []);
  const bare = source.replace("it.next.bind(it)", "it.next");
  assert.ok(ownerMessages("outer", "bare-generator-step.ts", bare).some(message => message.includes("UnknownEffect")));
});


test("unknown code invalidates an escaped object's callable members", () => {
  const source = `declare function share(value: unknown): void;
function outer() {
  const api = { run() { return 1; } };
  share(api);
  return api.run();
}
`;
  assert.deepEqual(ownerMessages("outer", "escaped-callable.ts", source), [
    "4:UnknownEffect: The function outer() calls unresolved callable, an unknown effect.",
    "5:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
  const known = source.replace("declare function share(value: unknown): void;", "function share(value: unknown) { return value; }");
  assert.deepEqual(ownerMessages("outer", "known-object-forward.ts", known), []);
});


test("iterating a yielded generator retains its deferred body effects", () => {
  const source = `const log: number[] = [];
function* gen() { log.push(1); yield 1; }
function* outer() { yield gen(); }
function run() {
  for (const iterator of outer()) {
    for (const value of iterator) { void value; }
  }
}
function cold() { for (const iterator of outer()) { void iterator; } }
`;
  assert.deepEqual(ownerMessages("outer", "yielded-generator.ts", source), []);
  assert.deepEqual(ownerMessages("run", "yielded-generator.ts", source), [
    "6:ImplicitOutput: The function run() writes log, an implicit output.",
  ]);
  assert.deepEqual(ownerMessages("cold", "yielded-generator.ts", source), []);
});


test("await preserves a known non-promise iterator until collection consumption", () => {
  const source = `const log: number[] = [];
function* gen() { log.push(1); yield 1; }
async function run() {
  return new Set(await gen()).size;
}
async function cold() { return await gen(); }
`;
  assert.ok(ownerMessages("run", "awaited-iterator.ts", source).includes(
    "4:ImplicitOutput: The function run() writes log, an implicit output."));
  assert.deepEqual(ownerMessages("cold", "awaited-iterator.ts", source).filter(message => message.includes("ImplicitOutput")), []);
});

test("a bound generator step retains the storage yielded in its result", () => {
  const source = `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function* gen() { yield shared; }
function outer() {
  const it = gen();
  const step = it.next.bind(it);
  return step().value![0];
}
`;
  assert.deepEqual(ownerMessages("outer", "bound-step-result.ts", source), [
    "7:ImplicitInput: The function outer() reads shared, an implicit input.",
  ]);
});


test("replaced bind and next members execute their replacement", () => {
  const bind = `let original = 0;
let replaced = 0;
function target() { original++; }
function outer() {
  target.bind = () => () => { replaced++; };
  const bound = target.bind(undefined);
  bound();
}
`;
  assert.deepEqual(ownerMessages("outer", "replaced-bind.ts", bind).filter(message => message.startsWith("7:")), [
    "7:ImplicitInput: The function outer() reads replaced, an implicit input.",
    "7:ImplicitOutput: The function outer() writes replaced, an implicit output.",
  ]);
  const next = `let original = 0;
let replaced = 0;
function* gen() { original++; yield 1; }
function outer() {
  const it = gen();
  it.next = () => { replaced++; return { value: 0, done: true }; };
  const step = it.next.bind(it);
  step();
}
`;
  assert.deepEqual(ownerMessages("outer", "replaced-next.ts", next).filter(message => message.startsWith("8:")), [
    "8:ImplicitInput: The function outer() reads replaced, an implicit input.",
    "8:ImplicitOutput: The function outer() writes replaced, an implicit output.",
  ]);
});


test("a class method closure retains a shared receiver read", () => {
  const source = `class Box {
  items: number[] = [];
  total() {
    const items = this.items;
    const read = () => items.length;
    return read();
  }
}
const shared = new Box();
function touch() { shared.items.push(1); }
function run() { return shared.total(); }
function local() { return new Box().total(); }
`;
  assert.deepEqual(ownerMessages("run", "captured-receiver.ts", source), [
    "11:ImplicitInput: The function run() reads shared, an implicit input.",
  ]);
  assert.deepEqual(ownerMessages("local", "captured-receiver.ts", source), []);
});


test("recorded library callbacks preserve unchanged array slots", () => {
  const source = `function outer() {
  const values = [0];
  const add = () => { values.length = 1; };
  [1, 2].forEach(add);
  const first = () => values[0];
  const second = () => values[1];
  return first() + second();
}
`;
  assert.deepEqual(ownerMessages("second", "callback-length.ts", source), []);
  const changed = source.replace("values.length = 1", "values[1] = 1");
  assert.deepEqual(ownerMessages("second", "callback-index.ts", changed), [
    "6:ImplicitInput: The arrow function second() reads values, an implicit input.",
  ]);
});


test("assigning an object to module storage preserves dispatch uncertainty", () => {
  const source = `let holder: object = {};
function make() {
  const api = { run() { return 1; } };
  holder = api;
  return api.run();
}
`;
  assert.ok(ownerMessages("make", "module-held-object.ts", source).includes(
    "5:UnknownEffect: The function make() calls overridable method, an unknown effect."));
  const local = source.replace("let holder: object = {};", "").replace("function make() {", "function make() { let holder: object = {};");
  assert.deepEqual(ownerMessages("make", "local-held-object.ts", local), []);
});


test("a later loop escape invalidates dispatch on the next iteration", () => {
  const source = `declare function share(value: object): void;
function use() {
  const api = { run() { return 1; } };
  let total = 0;
  for (let i = 0; i < 2; i++) {
    total += api.run();
    share(api);
  }
  return total;
}
`;
  assert.ok(ownerMessages("use", "loop-escape.ts", source).includes(
    "6:UnknownEffect: The function use() calls overridable method, an unknown effect."));
  const local = source.replace("declare function share(value: object): void;", "function share(value: object) { return value; }");
  assert.deepEqual(ownerMessages("use", "loop-known-share.ts", local), []);
});


test("loop widening preserves append floors and Set element positions", () => {
  const append = `function outer() {
  const values = [0];
  function add(item: number) { values.push(item); }
  function read() { return values[0]; }
  for (const x of [1, 2]) { values[values.length] = x; }
  add(9);
  return read();
}
`;
  assert.deepEqual(ownerMessages("read", "loop-append-floor.ts", append), []);
  const pairs = `const store: number[] = [];
function change() {
  const pairs = new Set([[[0], store]]);
  for (const [first] of pairs) { first.push(1); }
}
`;
  assert.deepEqual(ownerMessages("change", "set-private-position.ts", pairs), []);
  const shared = pairs.replace("[[[0], store]]", "[[store, [0]]]");
  assert.deepEqual(ownerMessages("change", "set-shared-position.ts", shared), [
    "4:ImplicitOutput: The function change() mutates caller-owned value first, an implicit output.",
  ]);
});


test("captured container reads name shared storage while direct aliases retain their name", () => {
  const source = `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function outer() {
  const xs: number[][] = [];
  xs.push(shared);
  const inner = () => xs[0][0];
  return inner();
}
function aliasRead() {
  const alias = shared;
  return alias[0];
}
`;
  assert.deepEqual(ownerMessages("inner", "captured-storage-name.ts", source), [
    "6:ImplicitInput: The arrow function inner() reads shared, an implicit input.",
  ]);
  assert.deepEqual(ownerMessages("outer", "captured-storage-name.ts", source), [
    "7:ImplicitInput: The function outer() reads shared, an implicit input.",
  ]);
  assert.deepEqual(ownerMessages("aliasRead", "captured-storage-name.ts", source), [
    "11:ImplicitInput: The function aliasRead() reads alias, an implicit input.",
  ]);
});


test("object key conversion invalidates callable storage exposed to coercion hooks", () => {
  for (const expression of ["table[api as any] = 1", "const value = table[api as any]", "const value = { [api as any]: 1 }"]) {
    const source = [
      "export function make() {",
      "  const api = { run() { return 1; } };",
      "  const table: any = {};",
      `  ${expression};`,
      "  return api.run();",
      "}",
    ].join("\n");
    assert.deepEqual(ownerMessages("make", "coercion-dispatch.ts", source), [
      "5:UnknownEffect: The function make() calls overridable method, an unknown effect.",
    ]);
    assert.deepEqual(ownerMessages("make", "scalar-key-dispatch.ts", source.replaceAll("api as any", '"safe"')), []);
  }
});

test("Object.assign replaces the original callable effect before invocation", () => {
  const source = `let original = 0, replacement = 0;
function outer() { const api = { run() { original++; return 1; } };
  Object.assign(api, { run: () => { replacement++; return 2; } });
  return api.run();
}
`;
  assert.deepEqual(ownerMessages("outer", "assign-replacement-effects.ts", source), [
    "4:ImplicitInput: The function outer() reads replacement, an implicit input.",
    "4:ImplicitOutput: The function outer() writes replacement, an implicit output.",
  ]);
});


test("awaiting a known iterator is quiet until its then member is exposed or replaced", () => {
  const source = `function* gen() { yield 1; }
async function cold() { return await gen(); }
async function patched() {
  const iterator: any = gen();
  iterator.then = (resolve: (value: number) => void) => resolve(1);
  return await iterator;
}
declare function expose(value: unknown): void;
async function escaped() {
  const iterator = gen();
  expose(iterator);
  return await iterator;
}
`;
  assert.deepEqual(ownerMessages("cold", "iterator-await-boundary.ts", source), []);
  for (const owner of ["patched", "escaped"]) {
    assert.ok(ownerMessages(owner, "iterator-await-boundary.ts", source).some(message => message.includes("uses unresolved await protocol")));
  }
});


test("a captured parameter mutation names the caller's actual storage through nested calls", () => {
  const source = `const store: number[] = [];
function outer(list: number[]) {
  const alias = list;
  const add = () => { alias.push(1); };
  add();
}
function caller() {
  outer(store);
}
function local() { outer([]); }
`;
  assert.deepEqual(ownerMessages("caller", "nested-parameter-origin.ts", source), [
    "8:ImplicitOutput: The function caller() mutates caller-owned value store, an implicit output.",
  ]);
  assert.deepEqual(ownerMessages("local", "nested-parameter-origin.ts", source), []);
});


test("iteration joins known generator and ordinary array alternatives", () => {
  const source = `const log: number[] = [];
function* gen() { log.push(1); yield 1; }
function plain() { return [1]; }
function run(flag: boolean) {
  const factory = flag ? gen : plain;
  for (const value of factory()) { void value; }
}
declare function external(): Iterable<number>;
function opaque(flag: boolean) {
  const factory = flag ? gen : external;
  for (const value of factory()) { void value; }
}
declare function unknownIterator(): ArrayIterator<number>;
function patched(flag: boolean) {
  const values = [1];
  values[Symbol.iterator] = unknownIterator;
  const iterator = flag ? gen() : values;
  for (const value of iterator) { void value; }
}
`;
  assert.deepEqual(ownerMessages("run", "mixed-iterables.ts", source), [
    "6:ImplicitOutput: The function run() writes log, an implicit output.",
  ]);
  for (const owner of ["opaque", "patched"]) {
    assert.ok(ownerMessages(owner, "mixed-iterables.ts", source).some(message => message.includes("uses unresolved iterate protocol")), owner);
  }
});


test("typeof guards remove plain noncallable alternatives and retain opaque functions", () => {
  for (const value of ["{}", "[]"]) {
    const source = `let count = 0;
function bump() { count += 1; }
function known(flag: boolean) {
  const action: any = flag ? bump : ${value};
  if (typeof action === "function") action();
}
function opaque(action: unknown) {
  if (typeof action === "function") action();
}
function impossible() {
  const action: any = ${value};
  if (typeof action === "function") action();
}
`;
    assert.deepEqual(ownerMessages("known", "typeof-callable.ts", source), [
      "5:ImplicitInput: The function known() reads count, an implicit input.",
      "5:ImplicitOutput: The function known() writes count, an implicit output.",
    ]);
    assert.ok(ownerMessages("opaque", "typeof-callable.ts", source).some(message => message.includes("calls unresolved callable")));
    assert.deepEqual(ownerMessages("impossible", "typeof-callable.ts", source), []);
  }
});

test("fresh inert construction ignores escape paths in uncalled methods", () => {
  const source = [
    "let count = 0;",
    "const seen: object[] = [];",
    "class First { keep() { seen.push(this); } run() { return 1; } }",
    "class Second { run() { return 2; } }",
    "class Third { run() { count += 1; return 3; } }",
    "let Kind: typeof First | typeof Second = First;",
    "export function choose() { Kind = Second; }",
    "export function make() { return new Kind().run(); }",
    "export function other() { return new Third().run(); }",
    "",
  ].join("\n");
  assert.deepEqual(ownerMessages("make", "fresh-class-selection.ts", source), [
    "8:ImplicitInput: The function make() reads Kind, an implicit input.",
  ]);
  assert.deepEqual(ownerMessages("other", "fresh-class-selection.ts", source), [
    "9:ImplicitInput: The function other() reads count, an implicit input.",
    "9:ImplicitOutput: The function other() writes count, an implicit output.",
  ]);
  for (const construction of [
    "constructor() { publish(this); }",
    "value = publish(this);",
  ]) {
    const open = [
      "declare function publish(value: object): void;",
      "class Box { " + construction + " run() { return 1; } }",
      "export function make() { return new Box().run(); }",
      "",
    ].join("\n");
    assert.ok(ownerMessages("make", "fresh-class-escape.ts", open).some((message) => message.includes("UnknownEffect")));
  }
});

test("computed replacement joins known callable effects and keeps opaque replacements unknown", () => {
  const pure = `export function make(name: string) {
  const api: any = { run() { return 1; } };
  api[name] = () => 2;
  return api.run();
}
`;
  assert.deepEqual(ownerMessages("make", "computed-pure-replacement.ts", pure), []);
  const action = `let count = 0;
export function make(name: string) {
  const api: any = { run() { return 1; } };
  api[name] = () => { count++; return 2; };
  return api.run();
}
`;
  assert.deepEqual(ownerMessages("make", "computed-action-replacement.ts", action), [
    "5:ImplicitInput: The function make() reads count, an implicit input.",
    "5:ImplicitOutput: The function make() writes count, an implicit output.",
  ]);
  const opaque = pure.replace("name: string", "name: string, fn: () => number").replace("() => 2", "fn");
  assert.ok(ownerMessages("make", "computed-opaque-replacement.ts", opaque).some((message) => message.includes("UnknownEffect")));
});

test("JSON replacer key and value association retains unknown mutation ownership", () => {
  const source = `function save() {
  const state = { count: 0 };
  return JSON.stringify(state, (key, value) => { if (key === "") { value.count += 1; } return value; });
}
`;
  assert.deepEqual(ownerMessages("save", "json-replacer-association.ts", source), [
    "3:UnknownEffect: The function save() mutates value with unknown ownership, an unknown effect.",
  ]);
});

test("recursive injected callbacks keep the owner's earliest unknown site", () => {
  const source = `function ping(value: number, notify: (value: number) => number): number {
  if (value <= 0) {
    return notify(value);
  }
  return pong(value - 1, notify);
}
function pong(value: number, notify: (value: number) => number): number {
  return ping(value, notify);
}
`;
  assert.deepEqual(ownerMessages("ping", "recursive-first-unknown.ts", source), [
    "3:UnknownEffect: The function ping() calls unresolved callable, an unknown effect.",
  ]);
  assert.deepEqual(ownerMessages("pong", "recursive-first-unknown.ts", source), [
    "8:UnknownEffect: The function pong() calls unresolved callable, an unknown effect.",
  ]);
});

test("definite member replacement removes the shared origin from an object rest copy", () => {
  const source = `const store = { items: [0], n: 1 };
function outer() {
  const { n, ...rest } = store;
  rest.items = [5];
  rest.items.push(1);
  return n;
}
`;
  assert.deepEqual(ownerMessages("outer", "rest-member-replacement.ts", source), []);
});

test("object rest copies retain shared members unless the selected member is definitely replaced", () => {
  for (const replacement of ["", "if (flag) rest.items = [5];", "rest[key] = [5];", "rest.other = [5];"]) {
    const source = `const store = { items: [0], other: [1] };
function outer(flag: boolean, key: "items" | "other") {
  const { ...rest } = store;
  ${replacement}
  rest.items.push(1);
}
`;
    assert.deepEqual(ownerMessages("outer", "rest-shared-twin.ts", source).map((message) => message.split(":")[1]), ["ImplicitOutput"], replacement);
  }
});

test("known callbacks stay known through direct and mutual recursion", () => {
  for (const recur of ["walk(n - 1, visit);", "back(n - 1, visit);"]) {
    const source = `function walk(n: number, visit: (k: number) => void): void {
  if (n === 0) return;
  visit(n);
  ${recur}
}
function back(n: number, visit: (k: number) => void): void { walk(n, visit); }
function outer() {
  const seen: number[] = [];
  walk(2, (k) => { seen.push(k); });
  return seen.length;
}
`;
    assert.deepEqual(ownerMessages("outer", "recursive-known-callback.ts", source), [], recur);
  }
});

test("recursive callback substitution retains effects and unresolved alternatives", () => {
  const helper = `function walk(n: number, visit: (k: number) => void): void {
  if (n === 0) return;
  visit(n);
  walk(n - 1, visit);
}
`;
  const action = helper + `let count = 0;
function outer() { walk(2, () => { count++; }); }
`;
  assert.deepEqual(ownerMessages("outer", "recursive-action-callback.ts", action).map((message) => message.split(":")[1]), ["ImplicitInput", "ImplicitOutput"]);
  const unknown = helper + `function outer(visit: (n: number) => void) { walk(2, visit); }
`;
  assert.deepEqual(ownerMessages("outer", "recursive-unknown-callback.ts", unknown).map((message) => message.split(":")[1]), ["UnknownEffect"]);
  const mixed = helper + `function outer(flag: boolean, visit: (n: number) => void) {
  walk(2, flag ? (() => 1) : visit);
}
`;
  assert.deepEqual(ownerMessages("outer", "recursive-mixed-callback.ts", mixed).map((message) => message.split(":")[1]), ["UnknownEffect"]);
});

test("higher order callback cycles terminate with an unresolved effect", () => {
  const source = `function walk(n: number, visit: (k: number) => void): void {
  if (n === 0) return;
  visit(n);
  walk(n - 1, visit);
}
function outer() {
  const visit = (n: number) => { walk(n - 1, visit); };
  walk(2, visit);
}
`;
  assert.deepEqual(ownerMessages("outer", "recursive-callback-cycle.ts", source).map((message) => message.split(":")[1]), ["UnknownEffect"]);
});

test("recursive callback substitution keeps closure instances and bound receivers", () => {
  const helper = `function walk(n: number, visit: (k: number) => void): void {
  if (n === 0) return;
  visit(n);
  walk(n - 1, visit);
}
`;
  const captures = helper + `const shared: number[] = [];
function visitor(items: number[]) { return (k: number) => { items.push(k); }; }
function outer() {
  const seen: number[] = [];
  const unused = visitor(shared);
  walk(2, visitor(seen));
  return seen.length;
}
`;
  assert.deepEqual(ownerMessages("outer", "recursive-callback-instances.ts", captures), []);
  const rebound = helper + `function outer() {
  let seen: number[] = [];
  const visit = (k: number) => { seen.push(k); };
  seen = [];
  walk(2, visit);
  return seen.length;
}
`;
  assert.deepEqual(ownerMessages("outer", "recursive-callback-rebind.ts", rebound), []);
  const bound = helper + `function outer() {
  const api = { items: [] as number[], put(k: number) { this.items.push(k); } };
  walk(2, api.put.bind(api));
  return api.items.length;
}
`;
  assert.deepEqual(ownerMessages("outer", "recursive-bound-callback.ts", bound), []);
});

test("immutable module methods keep identities through aliases and callbacks", () => {
  const cases = [
    { name: "k-nested-destructure-emit-A", source: `const svc = {
  inner: {
    emit(m: string): number {
      console.log(m);
      return 1;
    },
  },
};
function outer() {
  const { inner: { emit } } = svc;
  return emit("x");
}
`, kinds: ["ImplicitOutput"] },
    { name: "k-nested-destructure-emit-C", source: `const svc = {
  inner: {
    emit(m: string): number {
      const n = m.length;
      return n;
    },
  },
};
function outer() {
  const { inner: { emit } } = svc;
  return emit("x");
}
`, kinds: [] },
    { name: "k-method-as-callback-A", source: `const log: number[] = [];
const api = {
  put(n: number): number {
    log.push(n);
    return n;
  },
};
function twice(f: (n: number) => number) {
  return f(1) + f(2);
}
function outer() {
  return twice(api.put);
}
`, kinds: ["ImplicitOutput"] },
    { name: "k-method-as-callback-C", source: `const api = {
  put(n: number): number {
    const local: number[] = [];
    local.push(n);
    return n;
  },
};
function twice(f: (n: number) => number) {
  return f(1) + f(2);
}
function outer() {
  return twice(api.put);
}
`, kinds: [] },
    { name: "k-this-sibling-C", source: `const meter = {
  stamp(): number {
    return 1;
  },
  run(): number {
    return this.stamp() > 0 ? 1 : 0;
  },
};
function outer() {
  return meter.run();
}
`, kinds: [] },
  ];
  for (const item of cases) {
    assert.deepEqual(ownerMessages("outer", item.name + ".ts", item.source).map((message) => message.split(":")[1]), item.kinds, item.name);
  }
});


test("module callable cells retain external data and receiver ownership", () => {
  const shared = `const api = { items: [] as number[], put(n: number) { this.items.push(n); }, stamp() { return 1; } };
function outer() { api.put(1); return api.items[0]; }`;
  assert.ok(ownerMessages("outer", "module-method-data.ts", shared).some((message) => message.includes(":ImplicitOutput:")));
  const scalar = `let count = 0; function bump() { count++; } const api = { run() { return count; } };
function outer() { const f = api.run; return f(); }`;
  assert.ok(ownerMessages("outer", "module-method-scalar.ts", scalar).some((message) => message.includes(":ImplicitInput:")));
  const rebound = `const api = { items: [] as number[], put(n: number) { this.items.push(n); } };
function outer() { const local = { items: [] as number[] }; api.put.bind(local)(1); return local.items.length; }`;
  assert.deepEqual(ownerMessages("outer", "module-method-receiver.ts", rebound), []);
  const alias = `const api = { inner: { run() { return 1; } } };
function outer() { const child = api.inner; const { run } = child; return run(); }`;
  assert.deepEqual(ownerMessages("outer", "module-method-alias.ts", alias), []);
});

test("module callable shapes reject replaced or escaped members", () => {
  const cases = [
    `declare const replacement: () => number; const api = { run() { return 1; } }; api.run = replacement;
function outer() { const f = api.run; return f(); }`,
    `declare const replacement: { run(): number }; const api = { inner: { run() { return 1; } } }; api.inner = replacement;
function outer() { const { inner: { run } } = api; return run(); }`,
    `declare function change(value: unknown): void; const api = { inner: { run() { return 1; } } }; change(api.inner);
function outer() { const { inner: { run } } = api; return run(); }`,
    `declare function change(value: unknown): void; const api = { inner: { run() { return 1; } } }; const child = api.inner; change(child);
function outer() { const { inner: { run } } = api; return run(); }`,
    `declare function change(value: unknown): void; const api = { inner: { run() { return 1; } }, expose() { return this.inner; } }; change(api.expose());
function outer() { const f = api.inner.run; return f(); }`,
    `declare function change(value: unknown): void; const api = { inner: { run() { return 1; } }, expose() { const child = this.inner; return child; } }; change(api.expose());
function outer() { const f = api.inner.run; return f(); }`,
    `declare function change(value: unknown): void; const api = { inner: { run() { return 1; } }, expose() { return { get: () => this.inner }; } }; change(api.expose().get());
function outer() { const f = api.inner.run; return f(); }`,
    `const api = { run() { return 1; } };
function outer() { const f = api.run.missing; return f(); }`,
    `const api = { inner: { inner: { inner: { inner: { run() { return 1; } } } } } };
function outer() { const f = api.inner.inner.inner.inner.run; return f(); }`,
    `const api = { items: [] as number[], put(n: number) { this.items.push(n); } };
function outer() { const f = api.put; f(1); }`,
    `const api = { run() { return 1; } }; export { api };
function outer() { const f = api.run; return f(); }`,
    `declare const key: string; declare const replacement: () => number; const api = { run() { return 1; } }; api[key] = replacement;
function outer() { const f = api.run; return f(); }`,
    `declare const other: { run(): number }; const api = { run() { return 1; }, ...other };
function outer() { const f = api.run; return f(); }`,
  ];
  for (const [index, source] of cases.entries()) {
    assert.ok(ownerMessages("outer", `module-method-open-${index}.ts`, source).some((message) => message.includes(":UnknownEffect:")), source);
  }
});


test("recursive callback wrappers retain their captured callable", () => {
  const source = `function walk(n: number, f: () => number): number {
  if (n > 0) return walk(n - 1, () => f() + 1);
  return f();
}
function outer() { return walk(3, () => 0); }
`;
  assert.deepEqual(ownerMessages("outer", "recursive-captured-wrapper.ts", source), []);
});


test("recursive captured callbacks preserve actions and wrapper actions", () => {
  const walk = `function walk(n: number, f: () => number): number {
  if (n > 0) return walk(n - 1, () => f() + 1);
  return f();
}
`;
  const action = walk + `function outer() { return walk(3, () => { console.log("x"); return 0; }); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-captured-action.ts", action).map(message => message.split(":")[1]), ["ImplicitOutput"]);
  const ownAction = walk.replace("() => f() + 1", "() => { console.log('wrapper'); return f() + 1; }") + `function outer() { return walk(3, () => 0); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-wrapper-action.ts", ownAction).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});

test("recursive captured callbacks distinguish parameter owners", () => {
  const walk = `function walk(f: (x: number) => number, n: number): number {
  if (n > 0) return walk(x => f(x + 1), n - 1);
  return f(0);
}
`;
  assert.deepEqual(ownerMessages("outer", "recursive-parameter-owner.ts", walk + `function outer() { return walk(x => x, 3); }`), []);
  assert.deepEqual(ownerMessages("outer", "recursive-parameter-owner-action.ts", walk + `function outer() { return walk(x => { console.log(x); return x; }, 3); }`).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});

test("recursive wrappers preserve factory instances and current capture cells", () => {
  const walk = `function walk(n: number, f: () => number): number {
  if (n > 0) return walk(n - 1, () => f() + 1);
  return f();
}
`;
  const instances = walk + `function make(f: () => number) { return () => f(); }
function outer() {
  const quiet = make(() => 0);
  const action = make(() => { console.log("x"); return 1; });
  return walk(3, quiet);
}`;
  assert.deepEqual(ownerMessages("outer", "recursive-wrapper-instances.ts", instances), []);
  const reassigned = walk + `function make() {
  let f = () => 0;
  const wrapped = () => f();
  f = () => { console.log("x"); return 1; };
  return wrapped;
}
function outer() { return walk(3, make()); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-wrapper-reassign.ts", reassigned).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});

test("recursive captured callback stores reach the caller heap", () => {
  const source = `function walk(n: number, f: (x: number[]) => void, x: number[]): void {
  if (n > 0) walk(n - 1, y => f(y), x);
  else f(x);
}
function outer(value: number[]) {
  const boxes: number[][] = [];
  walk(3, x => { boxes.push(x); }, value);
  boxes[0].push(1);
}`;
  assert.deepEqual(ownerMessages("outer", "recursive-wrapper-stores.ts", source).filter(message => message.includes(":ImplicitOutput:")), [
    "8:ImplicitOutput: The function outer() mutates caller-owned value boxes, an implicit output.",
  ]);
});


test("recursive captured wrappers keep unresolved alternatives", () => {
  const walk = `function walk(n: number, f: () => number): number {
  if (n > 0) return walk(n - 1, () => f() + 1);
  return f();
}
`;
  const unknown = walk + `function outer(f: () => number) { return walk(3, f); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-wrapper-unknown.ts", unknown).map(message => message.split(":")[1]), ["UnknownEffect"]);
  const mixed = walk + `function outer(flag: boolean, f: () => number) { return walk(3, flag ? (() => 0) : f); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-wrapper-mixed.ts", mixed).map(message => message.split(":")[1]), ["UnknownEffect"]);
});


test("forwarded callback indexes are substituted in their owning context", () => {
  const source = `function use(f: () => void) { f(); }
function invoke(unused: () => void, f: () => void) { use(f); }
function outer(f: () => void) { invoke(() => 0, f); }
function entry() { outer(() => console.log("x")); }`;
  assert.deepEqual(ownerMessages("outer", "deferred-call-owner.ts", source).map(message => message.split(":")[1]), ["UnknownEffect"]);
  assert.deepEqual(ownerMessages("entry", "deferred-call-owner.ts", source).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});


test("forwarded callback payloads retain their parameter coordinates", () => {
  const source = `function invoke(unused: number[], x: number[], f: (x: number[]) => void) { f(x); }
function outer(x: number[], f: (x: number[]) => void) { invoke([], x, f); }
function entry(x: number[]) { outer(x, y => y.push(1)); }`;
  assert.deepEqual(ownerMessages("entry", "deferred-payload-owner.ts", source).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});

test("inherited constructors resolve their forwarded callbacks", () => {
  const source = `class Base { constructor(f: () => void) { f(); } }
class Derived extends Base {}
function outer() { new Derived(() => console.log("x")); }`;
  assert.deepEqual(ownerMessages("outer", "deferred-inherited-owner.ts", source).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});


test("recursive callback summaries keep payload parameter coordinates", () => {
  const source = `function invoke(unused: number[], x: number[], f: (x: number[]) => void) { f(x); }
function loop(x: number[], f: (x: number[]) => void, n: number): void {
  if (n > 0) loop(x, y => y.push(1), n - 1);
  invoke([], x, f);
}
function outer(x: number[]) { loop(x, () => {}, 1); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-payload-owner.ts", source).map(message => message.split(":")[1]), ["ImplicitOutput"]);
});

test("recursive callback payloads do not substitute unrelated arguments", () => {
  const source = `function invoke(unused: number[], x: number[], f: (x: number[]) => void) { f(x); }
function loop(x: number[], y: number[], f: (x: number[]) => void, n: number): void {
  if (n > 0) loop(x, y, f, n - 1);
  invoke(y, x, f);
}
function outer(y: number[]) { loop([], y, z => z.push(1), 1); }`;
  assert.deepEqual(ownerMessages("outer", "recursive-payload-private.ts", source), []);
});
