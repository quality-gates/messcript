import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

test("array mutators stay library calls when a class declares the same method name", () => {
  assert.deepEqual(messages("push-collision-local.ts", `class Q {
  push(x: number) { return x; }
}
function outer() {
  const a: number[] = [];
  a.push(1);
  return a.length;
}
`), []);
  assert.deepEqual(messages("push-collision-shared.ts", `const log: number[] = [];
class Q {
  push(x: number) { return x; }
}
function outer() {
  log.push(1);
  return 1;
}
`), ["6:ImplicitOutput: The function outer() writes log, an implicit output."]);
});

test("same-named methods still dispatch on receivers that are not standard storage", () => {
  assert.deepEqual(messages("push-collision-unknown.ts", `const log: number[] = [];
class Q {
  push(x: number) { log.push(x); return x; }
}
function outer(q: { push(x: number): number }) {
  return q.push(1);
}
`), [
    "3:ImplicitOutput: The method Q.push() writes log, an implicit output.",
    "6:ImplicitOutput: The function outer() writes log, an implicit output.",
    "6:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
});

test("a standard receiver still dispatches to members of derived classes", () => {
  assert.deepEqual(messages("array-subclass.ts", `const log: number[] = [];
class Loud extends Array<number> {
  join() { log.push(1); return ""; }
}
class Quiet {
  join() { log.push(2); return ""; }
}
function outer(xs: number[]) {
  return xs.join().length + 1;
}
`), [
    "3:ImplicitOutput: The method Loud.join() writes log, an implicit output.",
    "6:ImplicitOutput: The method Quiet.join() writes log, an implicit output.",
    "9:ImplicitOutput: The function outer() writes log, an implicit output.",
    "9:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
});

test("only class members take their class name, not methods of objects built inside them", () => {
  assert.deepEqual(messages("member-names.ts", `const log: number[] = [];
class A {
  get size() { log.push(0); return log.length; }
  run() {
    const helper = { f() { log.push(1); } };
    helper.f();
  }
  static { ({ g() { log.push(2); } }).g(); }
}
`).filter((message) => message.includes("ImplicitOutput")), [
    "3:ImplicitOutput: The accessor A.size() writes log, an implicit output.",
    "5:ImplicitOutput: The method f() writes log, an implicit output.",
    "6:ImplicitOutput: The method A.run() writes log, an implicit output.",
    "8:ImplicitOutput: The module writes log, an implicit output.",
    "8:ImplicitOutput: The method g() writes log, an implicit output.",
  ]);
});

test("an object literal with a __proto__ entry stays open to inherited members", () => {
  assert.deepEqual(messages("proto-literal-push.ts", `const log: number[] = [];
const proto = { push(x: number) { log.push(x); return 1; } };
function outer() {
  const o = { __proto__: proto } as unknown as { push(x: number): number };
  return o.push(1);
}
`), [
    "2:ImplicitOutput: The method push() writes log, an implicit output.",
    "5:ImplicitOutput: The function outer() writes log, an implicit output.",
    "5:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
  assert.deepEqual(messages("proto-literal-key.ts", `const log: number[] = [];
const proto = { push(x: number) { log.push(x); return 1; } };
function outer() {
  const o = { "__proto__": proto } as unknown as { push(x: number): number };
  return o.push(1);
}
`), [
    "2:ImplicitOutput: The method push() writes log, an implicit output.",
    "5:ImplicitOutput: The function outer() writes log, an implicit output.",
    "5:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
});

test("callee alias cycles resolve to the callables that enter the cycle", () => {
  assert.deepEqual(messages("callee-alias-cycle-effect.ts", `const log: number[] = [];
function outer() {
  let pick = () => { log.push(1); return 2; };
  const keep = pick;
  pick = keep;
  return pick();
}
`), [
    "3:ImplicitOutput: The arrow function pick() writes log, an implicit output.",
    "6:ImplicitOutput: The function outer() writes log, an implicit output.",
  ]);
  assert.deepEqual(messages("callee-alias-cycle-quiet.ts", `function outer() {
  let pick = () => 2;
  const keep = pick;
  pick = keep;
  return pick();
}
`), []);
});

test("a reassignment that dominates a loop-body write kills the earlier alias", () => {
  assert.deepEqual(messages("loop-reassign-before-push.ts", `const store: number[] = [];
function outer(n: number) {
  let target = store;
  for (let i = 0; i < n; i++) {
    target = [i];
    target.push(i);
  }
  return 0;
}
`), []);
  assert.deepEqual(messages("loop-reassign-after-push.ts", `const store: number[] = [];
function outer(n: number) {
  let target = store;
  for (let i = 0; i < n; i++) {
    target.push(i);
    target = [i];
  }
  return 0;
}
`), ["5:ImplicitOutput: The function outer() mutates caller-owned value target, an implicit output."]);
  assert.deepEqual(messages("loop-conditional-reassign.ts", `const store: number[] = [];
function outer(n: number) {
  let target = store;
  for (let i = 0; i < n; i++) {
    if (i > 0) { target = [i]; }
    target.push(i);
  }
  return 0;
}
`), ["6:ImplicitOutput: The function outer() mutates caller-owned value target, an implicit output."]);
  assert.deepEqual(messages("switch-fallthrough-reassign.ts", `const store: number[] = [];
function outer(k: number) {
  let target = store;
  switch (k) {
    case 1:
      target = [];
    case 2:
      target.push(1);
  }
  return 0;
}
`), ["8:ImplicitOutput: The function outer() mutates caller-owned value target, an implicit output."]);
});

test("an array destructuring assignment rebinds each name to the matching source element", () => {
  assert.deepEqual(messages("swap-destructure-shared.ts", `const shared = [0];
function outer() {
  let a = shared;
  let b = [0];
  [a, b] = [b, a];
  b[0] = 1;
  return a[0];
}
`), ["6:ImplicitOutput: The function outer() mutates caller-owned value b, an implicit output."]);
  assert.deepEqual(messages("swap-destructure-private.ts", `const shared = [0];
function outer() {
  let a = shared;
  let b = [0];
  [a, b] = [b, a];
  a[0] = 1;
  return b.length;
}
`), []);
});

test("one storage reached through several aliases is reported once, at its first site", () => {
  assert.deepEqual(messages("alias-chain-dedupe.ts", `function outer(xs: number[]) {
  const first = xs;
  const second = first;
  second[0] = 1;
  first[1] = 2;
  return second[1];
}
`), ["4:ImplicitOutput: The function outer() mutates caller-owned value second, an implicit output."]);
  assert.deepEqual(messages("alias-then-direct.ts", `const store: number[] = [];
function outer() {
  const a = store;
  a.push(1);
  store.push(2);
  return 0;
}
`), ["4:ImplicitOutput: The function outer() writes a, an implicit output."]);
  assert.deepEqual(messages("distinct-storage.ts", `const left: number[] = [];
const right: number[] = [];
function outer(xs: number[], ys: number[]) {
  left.push(1);
  right.push(2);
  xs[0] = 1;
  ys[0] = 2;
  return 0;
}
`), [
    "4:ImplicitOutput: The function outer() writes left, an implicit output.",
    "5:ImplicitOutput: The function outer() writes right, an implicit output.",
    "6:ImplicitOutput: The function outer() mutates argument xs, an implicit output.",
    "7:ImplicitOutput: The function outer() mutates argument ys, an implicit output.",
  ]);
});

test("reflective writes whose member names are unknown make method dispatch incomplete", () => {
  assert.deepEqual(messages("prototype-mixin.ts", `const mixin = {
  tick(): number {
    return Date.now();
  },
};
class Counter {
  tick(): number {
    return 0;
  }
}
Object.assign(Counter.prototype, mixin);
function outer() {
  return new Counter().tick();
}
`), [
    "3:ImplicitInput: The method tick() calls Date.now(), an implicit input.",
    "11:ImplicitOutput: The module writes Counter, an implicit output.",
    "13:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
  assert.deepEqual(messages("define-variable-key.ts", `const key = "tick";
class Counter {
  tick(): number {
    return 0;
  }
}
Object.defineProperty(Counter.prototype, key, { value: () => Date.now() });
function outer() {
  return new Counter().tick();
}
`), [
    "7:UnknownEffect: The module calls unresolved callable, an unknown effect.",
    "7:ImplicitInput: The arrow function anonymous() calls Date.now(), an implicit input.",
    "9:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
  assert.deepEqual(messages("assign-fresh-copy.ts", `class Counter {
  tick(): number {
    return 0;
  }
}
function copy(source: object) {
  return Object.assign({}, source);
}
function outer() {
  return new Counter().tick();
}
`), []);
});

test("a member defined through a property map can replace the class member", () => {
  const source = (map) => `const log: number[] = [];
class Counter {
  tick() { return 0; }
}
Object.defineProperties(Counter.prototype, ${map});
function outer() {
  return new Counter().tick();
}
`;
  const outer = (name, text) => messages(name, text).filter(message => message.includes("outer()"));
  assert.deepEqual(outer("define-properties-literal.ts", source("{ tick: { value: () => { log.push(1); return 1; } } }")),
    ["7:UnknownEffect: The function outer() calls overridable method, an unknown effect."]);
  assert.deepEqual(outer("define-properties-opaque.ts", source("descriptors()")),
    ["7:UnknownEffect: The function outer() calls overridable method, an unknown effect."]);
  assert.deepEqual(outer("define-properties-other.ts", source("{ other: { value: 1 } }")), []);
});

test("a computed prototype key or an aliased define call can replace the class member", () => {
  const source = (patch) => `const log: number[] = [];
class Counter {
  tick() { return 0; }
}
${patch}
function outer() {
  return new Counter().tick();
}
`;
  const outer = (name, text) => messages(name, text).filter(message => message.includes("outer()"));
  const replaced = ["7:UnknownEffect: The function outer() calls overridable method, an unknown effect."];
  const value = `{ value: () => { log.push(1); return 1; } }`;
  assert.deepEqual(outer("patch-computed-key.ts", source(`(Counter.prototype as any)[["ti", "ck"].join("")] = () => { log.push(1); return 1; };`)), [
    "7:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
    "7:ImplicitInput: The function outer() reads Counter, an implicit input.",
  ]);
  assert.deepEqual(outer("patch-alias.ts", source(`const define = Object.defineProperty; define(Counter.prototype, "tick", ${value});`)), replaced);
  assert.deepEqual(outer("patch-destructured.ts", source(`const { defineProperty } = Object; defineProperty(Counter.prototype, "tick", ${value});`)), replaced);
  assert.deepEqual(outer("patch-call.ts", source(`Object.defineProperty.call(null, Counter.prototype, "tick", ${value});`)), replaced);
  assert.deepEqual(outer("patch-element.ts", source(`Object["defineProperty"](Counter.prototype, "tick", ${value});`)), replaced);
  assert.deepEqual(outer("patch-cast-other.ts", source(`(Object.defineProperty as any)(Counter.prototype, "other", { value: 1 });`)), []);
  assert.deepEqual(outer("patch-record-key.ts", source(`const rec: Record<string, number> = {}; rec[["ti", "ck"].join("")] = 1;`)), []);
});

test("creating a generator runs its default parameters at the call", () => {
  assert.deepEqual(messages("generator-default-create.ts", `const log: number[] = [];
function* gen(
  n: number = log.push(1),
) {
  yield n;
}
function outer() {
  gen();
  return 0;
}
function given() {
  gen(2);
  return 0;
}
function later() {
  const it = gen();
  for (const value of it) {
    log.length = value;
  }
}
`), [
    "3:ImplicitOutput: The function gen() writes log, an implicit output.",
    "8:ImplicitOutput: The function outer() writes log, an implicit output.",
    "16:ImplicitOutput: The function later() writes log, an implicit output.",
  ]);
});

test("a later literal property overrides an earlier spread member", () => {
  assert.deepEqual(messages("spread-override-fresh.ts", `function outer(cfg: { name: string; opts: { level: number }; tags: string[] }) {
  const c = { ...cfg, opts: { ...cfg.opts } };
  c.opts.level = 2;
  return c.tags.length;
}
`), []);
  assert.deepEqual(messages("spread-override-before.ts", `function outer(cfg: { opts: { level: number } }) {
  const c = { opts: { level: 0 }, ...cfg };
  c.opts.level = 2;
}
`), ["3:ImplicitOutput: The function outer() mutates caller-owned value c, an implicit output."]);
  assert.deepEqual(messages("spread-override-two.ts", `function outer(cfg: { opts: { level: number } }, more: { opts: { level: number } }) {
  const c = { ...cfg, ...more, name: "x" };
  c.opts.level = 2;
}
`), ["3:ImplicitOutput: The function outer() mutates caller-owned value c, an implicit output."]);
});

test("a computed key overrides only the members written before it", () => {
  assert.deepEqual(messages("computed-before.ts", `const store: number[] = [];
export function change(key: string): void {
  const holder = { [key]: store, b: [0] };
  holder.b.push(1);
}
`), []);
  assert.deepEqual(messages("computed-after.ts", `const store: number[] = [];
export function change(key: string): void {
  const holder = { b: [0], [key]: store };
  holder.b.push(1);
}
`), ["4:ImplicitOutput: The function change() mutates caller-owned value holder, an implicit output."]);
});

test("a typed parameter member supports iteration", () => {
  assert.deepEqual(messages("member-for-of.ts", `type Bag = { [Symbol.iterator](): Iterator<number> };
export function run(box: { items: number[] }, bag: { items: Bag }) {
  for (const x of box.items) {
    void x;
  }
  for (const y of bag.items) {
    void y;
  }
}
`), ["6:UnknownEffect: The function run() uses unresolved iterate protocol, an unknown effect."]);
  assert.deepEqual(messages("spread-override-shared.ts", `function outer(cfg: { name: string; opts: { level: number }; tags: string[] }) {
  const c = { ...cfg, tags: [...cfg.tags] };
  c.opts.level = 2;
  return c.tags.length;
}
`), ["3:ImplicitOutput: The function outer() mutates caller-owned value c, an implicit output."]);
  assert.deepEqual(messages("member-iterate-alias.ts", `type Cfg = { tags: string[] } | ({ tags: Set<string> });
function outer(cfg: Cfg) {
  return [...cfg.tags];
}
`), []);
  assert.deepEqual(messages("member-iterate-optional.ts", `function outer(cfg: { tags?: string[] }) {
  return [...cfg.tags!];
}
`), ["2:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect."]);
  assert.deepEqual(messages("member-iterate-custom.ts", `type Bag = { [Symbol.iterator](): Iterator<number> };
function outer(cfg: { tags: Bag }, more: { tags: string[]; extra: string[] }) {
  return [...cfg.tags, ...more.extra];
}
`), ["3:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect."]);
  assert.deepEqual(messages("member-iterate-local.ts", `function outer(tags: string[]) {
  let cfg = { tags };
  cfg = { tags: [] };
  return [...cfg.tags];
}
`), ["4:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect."]);
});

test("a static class field resolves its standard methods until an accessor or a write may replace it", () => {
  assert.deepEqual(messages("static-field.ts", `class Cfg {
  static readonly ITEMS: number[] = [1];
  static add(n: number) {
    const copy = Cfg.ITEMS.slice();
    copy.push(n);
  }
}
function outer() { return Cfg.ITEMS.length; }
`), []);
  assert.deepEqual(messages("static-accessor.ts", `class Cfg {
  static get ITEMS(): number[] { return [1]; }
}
function add() { return Cfg.ITEMS.slice(); }
`), ["4:UnknownEffect: The function add() calls unresolved callable, an unknown effect."]);
  assert.deepEqual(messages("static-replaced.ts", `class Cfg {
  static ITEMS: any = [1];
  static { this.ITEMS = { slice() { return []; } }; }
}
function add() { return Cfg.ITEMS.slice(); }
`).filter((message) => message.includes("add()")), ["5:UnknownEffect: The function add() calls overridable method, an unknown effect."]);
});

test("a module array literal iterates without code until a write may give it its own iterator", () => {
  assert.deepEqual(messages("module-row-spread.ts", `const grid: number[][] = [[0, 0], [1, 1]];
const registry = { rows: [1, 2] };
const { rows } = registry;
function outer() {
  const copy = [...grid];
  return [...copy[1], ...rows];
}
`), []);
  assert.deepEqual(messages("module-keyed-writes.ts", `const items = [1, 2];
const seen = new Set<number>();
function set(index: number, value: number) { items[index] = value; items.push(value); seen.add(value); }
function all() { return [...items, ...seen]; }
`).filter((message) => message.includes("UnknownEffect")), []);
  assert.deepEqual(messages("module-iterator-write.ts", `const rows: any = [1, 2];
function hack() { rows[Symbol.iterator] = function* () { console.log("y"); }; }
function outer() { hack(); return [...rows]; }
`).filter((message) => message.includes("outer()")), [
    "3:ImplicitOutput: The function outer() writes rows, an implicit output.",
    "3:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.",
    "3:ImplicitInput: The function outer() reads rows, an implicit input.",
  ]);
});

test("a spread before a destructured position hides which element it receives", () => {
  assert.deepEqual(messages("swap-spread-before.ts", `function outer(xs: number[][]) {
  let a = [0];
  let b = [0];
  [a, b] = [...xs, [1]];
  b[0] = 1;
  return a.length;
}
`), ["5:UnknownEffect: The function outer() mutates value with unknown ownership, an unknown effect."]);
  assert.deepEqual(messages("swap-spread-after.ts", `function outer(xs: number[][]) {
  let a = [0];
  let b = [0];
  [a, b] = [[1], [2], ...xs];
  b[0] = 1;
  return a.length;
}
`), []);
});

test("spread exclusions keep every later name and carry through nested spreads", () => {
  assert.deepEqual(messages("spread-two-later.ts", `function outer(cfg: { a: number[]; b: number[] }) {
  const h = { ...cfg, a: [0], b: [0] };
  h.a.push(1);
  h.b.push(1);
}
`), []);
  assert.deepEqual(messages("spread-nested.ts", `function outer(cfg: { y: number[] }) {
  const a = { ...cfg, x: [0] };
  const b = { ...a, y: [0] };
  b.y.push(1);
}
`), []);
  assert.deepEqual(messages("spread-later-wildcard.ts", `function outer(cfg: { a: number[] }, k: string) {
  const items = [[0]];
  const h = { ...cfg, ...items };
  h[k].push(1);
}
`), ["4:ImplicitOutput: The function outer() mutates caller-owned value h, an implicit output."]);
});

test("Object.assign from literal sources defines only the listed member names", () => {
  assert.deepEqual(messages("assign-literal-other.ts", `class Counter {
  tick(): number {
    return 0;
  }
}
Object.assign(Counter.prototype, { other() { return 1; } });
function outer() {
  return new Counter().tick();
}
`), ["6:ImplicitOutput: The module writes Counter, an implicit output."]);
  assert.deepEqual(messages("assign-literal-empty.ts", `class Counter {
  tick(): number {
    return 0;
  }
}
Object.assign(Counter.prototype, {});
function outer() {
  return new Counter().tick();
}
`), ["6:ImplicitOutput: The module writes Counter, an implicit output."]);
  assert.deepEqual(messages("reflect-set-no-key.ts", `class Counter {
  tick(): number {
    return 0;
  }
}
Reflect.set(Counter.prototype);
function outer() {
  return new Counter().tick();
}
`), ["8:UnknownEffect: The function outer() calls overridable method, an unknown effect."]);
});

test("a typed parameter member fails closed unless every member type iterates", () => {
  const unresolved = (line) => [`${line}:UnknownEffect: The function outer() uses unresolved iterate protocol, an unknown effect.`];
  assert.deepEqual(messages("member-cycle.ts", `type Loop = Loop;
function outer(box: Loop) {
  return [...box.items];
}
`), unresolved(3));
  assert.deepEqual(messages("member-paren.ts", `type Bag = { [Symbol.iterator](): Iterator<number> };
function outer(box: ({ items: Bag })) {
  return [...box.items];
}
`), unresolved(3));
  assert.deepEqual(messages("member-alias-bag.ts", `type Bag = { [Symbol.iterator](): Iterator<number> };
type Holder = { items: Bag };
function outer(box: Holder) {
  return [...box.items];
}
`), unresolved(4));
  assert.deepEqual(messages("member-mixed-union.ts", `type Bag = { [Symbol.iterator](): Iterator<number> };
function outer(box: { items: number[] } | { items: Bag }) {
  return [...box.items];
}
`), unresolved(3));
  assert.deepEqual(messages("member-method-signature.ts", `function outer(box: { items(): number[] }) {
  return [...box.items];
}
`), unresolved(2));
  assert.deepEqual(messages("member-optional-plain.ts", `function outer(box: { items?: number[] }) {
  return [...box.items];
}
`), unresolved(2));
  assert.deepEqual(messages("member-duplicate.ts", `type Bag = { [Symbol.iterator](): Iterator<number> };
function outer(box: { items: number[]; items: Bag }) {
  return [...box.items];
}
`), unresolved(3));
  assert.deepEqual(messages("member-call-owner.ts", `declare function make(): { items: number[] };
function outer() {
  return [...make().items];
}
`), unresolved(3));
});

test("a __proto__ entry keeps a literal open even beside other members", () => {
  assert.deepEqual(messages("proto-literal-plus.ts", `const log: number[] = [];
const proto = { push(x: number) { log.push(x); return 1; } };
function outer() {
  const o = { __proto__: proto, size: 1 } as unknown as { push(x: number): number };
  return o.push(1);
}
`), [
    "2:ImplicitOutput: The method push() writes log, an implicit output.",
    "5:ImplicitOutput: The function outer() writes log, an implicit output.",
    "5:UnknownEffect: The function outer() calls overridable method, an unknown effect.",
  ]);
});

test("projected array receivers preserve shallow-copy provenance", () => {
  for (const [name, type, access] of [
    ["record", "{ a: number[][] }", "box.a"],
    ["nested", "{ nested: { a: number[][] } }", "box.nested.a"],
    ["literal-key", "{ a: number[][] }", 'box["a"]'],
    ["alias", "Box", "box.a"],
    ["union", "{ a: number[][] } | { a: readonly number[][] }", "box.a"],
  ]) {
    const wrap = name === "nested" ? "{ nested: { a: VALUE } }" : "{ a: VALUE }";
    const source = (value) => `type Box = { a: number[][] };
const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(box: ${type}) { return ${access}.slice(0)[0][0]; }
function outer() { return inner(${wrap.replace("VALUE", value)}); }
`;
    assert.deepEqual(messages(`projected-${name}-shared.ts`, source("[shared]")), [
      "3:ImplicitOutput: The function bump() writes shared, an implicit output.",
      "5:ImplicitInput: The function outer() reads shared, an implicit input.",
    ]);
    assert.deepEqual(messages(`projected-${name}-private.ts`, source("[[1]]")), [
      "3:ImplicitOutput: The function bump() writes shared, an implicit output.",
    ]);
  }
});

test("projected receivers require a proof for every member and method", () => {
  for (const [name, source] of [
    ["custom", "function outer(box: { a: { slice(n: number): number[] } }) { return box.a.slice(0); }"],
    ["mixed", "function outer(box: { a: number[] } | { a: { slice(n: number): number[] } }) { return box.a.slice(0); }"],
    ["dynamic", "function outer(box: Record<string, number[]>, key: string) { return box[key].slice(0); }"],
  ]) {
    assert.deepEqual(messages(`projected-${name}.ts`, source), [
      "1:UnknownEffect: The function outer() calls unresolved callable, an unknown effect.",
    ]);
  }
  assert.deepEqual(messages("projected-replaced-method.ts", `const shared: number[] = [1];
function custom(n: number) { shared[0] = 2; return [1]; }
function outer(box: { a: number[] }) {
  box.a.slice = custom;
  return box.a.slice(0);
}
`), [
    "2:ImplicitOutput: The function custom() writes shared, an implicit output.",
    "4:ImplicitOutput: The function outer() mutates argument box, an implicit output.",
    "5:ImplicitOutput: The function outer() writes shared, an implicit output.",
  ]);
});

test("a constructor that returns an object puts its members in place of the class members", () => {
  const source = (body, base = "") => `const log: number[] = [];
${base}
class Counter${base ? " extends Base" : ""} {
  ${body}
  tick() { return 0; }
}
function outer() {
  return new Counter().tick();
}
`.split("\n").filter(Boolean).join("\n") + "\n";
  const outer = (name, text) => messages(name, text).filter(message => message.includes("outer()"));
  const replacing = "constructor() { return { tick: () => { log.push(1); return 1; } }; }";
  assert.deepEqual(outer("ctor-return-own.ts", source(replacing)), ["7:ImplicitOutput: The function outer() writes log, an implicit output."]);
  assert.deepEqual(outer("ctor-return-quiet.ts", source("constructor() { return { tick: () => 1 }; }")), []);
  assert.deepEqual(outer("ctor-return-inherited.ts", source("", `class Base { ${replacing} }`)),
    ["8:ImplicitOutput: The function outer() writes log, an implicit output."]);
  assert.deepEqual(outer("ctor-return-opaque.ts", source("constructor() { return make(); }",
    "function make() { return { tick: () => { log.push(1); return 1; } }; }")),
  ["8:UnknownEffect: The function outer() calls overridable method, an unknown effect."]);
  assert.deepEqual(outer("ctor-return-overload.ts", source(`constructor();
  constructor(x?: number) { return { tick: () => { log.push(1); return 1; } }; }`)),
  ["8:ImplicitOutput: The function outer() writes log, an implicit output."]);
  assert.deepEqual(outer("ctor-return-primitive.ts", source("constructor(flag = false) { if (flag) { return undefined; } return -1 as any; }")), []);
});
