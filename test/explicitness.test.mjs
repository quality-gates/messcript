import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import ts from "typescript";
import { collectImplicitFlows } from "../dist/analysis/explicitness.js";
import { runCli as runCliInProcess } from "../dist/cli.js";
import { findImplicitInput } from "../dist/rules/implicit-input.js";
import { findImplicitOutput } from "../dist/rules/implicit-output.js";

let workspace;
let strictRuleset;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "messcript-explicitness-"));
  strictRuleset = join(workspace, "strict.xml");
  writeFileSync(strictRuleset, `<ruleset name="strict">
  <rule ref="rulesets/explicitness.xml/ImplicitInput">
    <properties><property name="include-this" value="true" /></properties>
  </rule>
  <rule ref="rulesets/explicitness.xml/ImplicitOutput">
    <properties><property name="include-this" value="true" /></properties>
  </rule>
</ruleset>
`);
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function captureOutput() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { stream, read: () => output };
}

function messages(name, source, ruleset = "explicitness") {
  const path = join(workspace, name);
  writeFileSync(path, source);
  const stdout = captureOutput();
  const stderr = captureOutput();
  runCliInProcess([path, "json", ruleset], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(stderr.read(), "");
  return JSON.parse(stdout.read()).findings.map((finding) => `${finding.line}:${finding.ruleName}: ${finding.message}`);
}

test("indirect writes make reads of the original shared storage implicit", () => {
  assert.deepEqual(messages("shared-alias-write.ts", `const shared: number[] = [];
function write() { const alias = shared; alias.push(1); }
function read() { return shared.length; }
`), [
    "2:ImplicitInput: The function write() reads shared, an implicit input.",
    "2:ImplicitOutput: The function write() mutates caller-owned value alias, an implicit output.",
    "3:ImplicitInput: The function read() reads shared, an implicit input.",
  ]);
  assert.deepEqual(messages("shared-helper-write.ts", `const shared: number[] = [];
function mutate(value: number[]) { value.push(1); }
function write() { mutate(shared); }
function read() { return shared.length; }
`), [
    "2:ImplicitOutput: The function mutate() mutates argument value, an implicit output.",
    "3:ImplicitOutput: The function write() mutates caller-owned value shared, an implicit output.",
    "3:ImplicitInput: The function write() reads shared, an implicit input.",
    "4:ImplicitInput: The function read() reads shared, an implicit input.",
  ]);
  assert.deepEqual(messages("private-alias-read.ts", `const shared: number[] = [];
function read() { const alias = shared; return alias.length; }
`), []);
});

test("alias writes make captured reads of local storage implicit", () => {
  assert.deepEqual(messages("captured-object-alias.ts", `function outer() {
  const box = { n: 0 };
  const alias = box;
  function inner() { return box.n; }
  alias.n = 1;
  return inner();
}
`), ["4:ImplicitInput: The function inner() reads box, an implicit input."]);
  assert.deepEqual(messages("captured-array-alias.ts", `function outer() {
  const values: number[] = [];
  const alias = values;
  function inner() { return values.length; }
  alias.push(1);
  return inner();
}
`), ["4:ImplicitInput: The function inner() reads values, an implicit input."]);
  assert.deepEqual(messages("captured-helper-write.ts", `function change(value: { n: number }) { value.n = 1; }
function outer() {
  const box = { n: 0 };
  function inner() { return box.n; }
  change(box);
  return inner();
}
`), [
    "1:ImplicitOutput: The function change() mutates argument value, an implicit output.",
    "4:ImplicitInput: The function inner() reads box, an implicit input.",
  ]);
  assert.deepEqual(messages("captured-quiet.ts", `function outer() {
  const values: number[] = [];
  function inner() { return values.length; }
  return inner();
}
`), []);
});

test("alias writes leave disjoint captured fields quiet", () => {
  assert.deepEqual(messages("captured-disjoint-one-level.ts", `function outer() {
  const box = { n: 0, m: 0 };
  function read() { return box.m; }
  box.n = 1;
  return read();
}
`), []);
  assert.deepEqual(messages("captured-disjoint-one-level-alias.ts", `function outer() {
  const box = { n: 0, m: 0 };
  const alias = box;
  function read() { return box.m; }
  alias.n = 1;
  return read();
}
`), []);
  assert.deepEqual(messages("captured-disjoint-array-elements.ts", `function outer() {
  const values = [0, 0];
  const alias = values;
  function read() { return values[1]; }
  alias[0] = 1;
  return read();
}
`), []);
  assert.deepEqual(messages("captured-disjoint-array.ts", `function outer() {
  const box = { n: 0, items: [0] };
  const alias = box.items;
  function read() { return box.n; }
  alias[0] = 1;
  return read();
}
`), []);
  assert.deepEqual(messages("captured-disjoint-record.ts", `function outer() {
  const box = { left: { n: 0 }, right: { n: 0 } };
  const alias = box.left;
  function read() { return box.right.n; }
  alias.n = 1;
  return read();
}
`), []);
  assert.deepEqual(messages("captured-disjoint-direct.ts", `function outer() {
  const box = { left: { n: 0 }, right: { n: 0 } };
  function read() { return box.right.n; }
  box.left.n = 1;
  return read();
}
`), []);
  assert.deepEqual(messages("captured-matching-direct.ts", `function outer() {
  const box = { left: { n: 0 }, right: { n: 0 } };
  function read() { return box.right.n; }
  box.right.n = 1;
  return read();
}
`), ["3:ImplicitInput: The function read() reads box, an implicit input."]);
});

test("value exports and exported callable returns expose container storage", () => {
  assert.deepEqual(messages("named-container-export.ts", `const shared: number[] = [];
export { shared as values };
function read() { return shared.length; }
`), [
    "3:ImplicitInput: The function read() reads shared, an implicit input.",
  ]);
  assert.deepEqual(messages("exported-storage-return.ts", `const shared: number[] = [];
export function get() { return shared; }
function read() { return shared.length; }
`), [
    "2:ImplicitInput: The function get() reads shared, an implicit input.",
    "3:ImplicitInput: The function read() reads shared, an implicit input.",
  ]);
  assert.deepEqual(messages("named-callable-export.ts", `const shared: number[] = [];
const get = () => shared;
export { get as values };
function read() { return shared.length; }
`), [
    "2:ImplicitInput: The arrow function get() reads shared, an implicit input.",
    "4:ImplicitInput: The function read() reads shared, an implicit input.",
  ]);
  assert.deepEqual(messages("exported-scalar-copy.ts", `const shared: number[] = [1];
export function get() { return shared.slice(); }
function read() { return shared.length; }
`), []);
  assert.deepEqual(messages("type-only-container-export.ts", `const shared: number[] = [];
export type { shared };
function read() { return shared.length; }
`), []);
});

test("the book add_to_total example reports its global input and its global and console outputs", () => {
  assert.deepEqual(messages("book.js", `let total = 0;
function add_to_total(amount) {
  console.log("Old total: " + total);
  total += amount;
  return total;
}
`), [
    "3:ImplicitOutput: The function add_to_total() uses console, an implicit output.",
    "3:ImplicitInput: The function add_to_total() reads total, an implicit input.",
    "4:ImplicitOutput: The function add_to_total() writes total, an implicit output.",
  ]);
});

test("a calculation that uses only its arguments, locals, and constants has no findings", () => {
  assert.deepEqual(messages("pure.ts", `import { rate } from "./rate";
const limit = 10;
const lookup = { a: 1 };
function helper(value: number): number { return value * rate; }
export function pure(values: number[], key: "a"): number {
  const local: number[] = [];
  local.push(...values);
  let sum = 0;
  for (const value of local) { sum += helper(value); }
  return Math.min(sum, limit) + lookup[key] + values.slice().sort().length;
}
`), []);
});

test("mutating an argument is an output, but reassigning the argument is not", () => {
  assert.deepEqual(messages("argument.js", `function addItem(cart, item) {
  cart.push(item);
  return cart;
}
function replace(cart) {
  cart = [];
  return cart;
}
function setName(user, name) { user.name = name; }
`), [
    "2:ImplicitOutput: The function addItem() mutates argument cart, an implicit output.",
    "9:ImplicitOutput: The function setName() mutates argument user, an implicit output.",
  ]);
});

test("a read of a mutable outer binding is an input and a compound write is both", () => {
  assert.deepEqual(messages("closure.js", `const cache = [];
function remember(value) { cache.push(value); }
function size() { return cache.length; }
function counter() {
  let count = 0;
  return () => ++count;
}
`), [
    "2:ImplicitOutput: The function remember() writes cache, an implicit output.",
    "3:ImplicitInput: The function size() reads cache, an implicit input.",
    "6:ImplicitInput: The arrow function anonymous() reads count, an implicit input.",
    "6:ImplicitOutput: The arrow function anonymous() writes count, an implicit output.",
  ]);
});

test("nondeterministic calls and host state are implicit inputs and outputs", () => {
  assert.deepEqual(messages("ambient.js", `function stamp(offset) { return Date.now() + Math.random() + new Date(offset).getTime(); }
function today() { return new Date(); }
function render(text) { document.querySelector("#out").textContent = text; }
function language() { return navigator.language; }
function send(body) { return fetch("/api", { body }); }
`), [
    "1:ImplicitInput: The function stamp() calls Date.now(), an implicit input.",
    "1:ImplicitInput: The function stamp() calls Math.random(), an implicit input.",
    "2:ImplicitInput: The function today() calls new Date(), an implicit input.",
    "3:ImplicitOutput: The function render() writes document, an implicit output.",
    "3:UnknownEffect: The function render() calls unresolved callable, an unknown effect.",
    "4:ImplicitInput: The function language() reads navigator, an implicit input.",
    "5:ImplicitOutput: The function send() uses fetch, an implicit output.",
  ]);
});

test("nondeterministic calls through wrapped receivers and literal element access are inputs", () => {
  assert.deepEqual(messages("wrapped-ambient.ts", `function f1() { return (Date).now(); }
function f2() { return Date["now"](); }
function f3() { return (Math).random(); }
function f4() { return Math["random"](); }
function f5() { return new (Date)(); }
`), [
    "1:ImplicitInput: The function f1() calls Date.now(), an implicit input.",
    "2:ImplicitInput: The function f2() calls Date.now(), an implicit input.",
    "3:ImplicitInput: The function f3() calls Math.random(), an implicit input.",
    "4:ImplicitInput: The function f4() calls Math.random(), an implicit input.",
    "5:ImplicitInput: The function f5() calls new Date(), an implicit input.",
  ]);
});

test("lexical scopes and write forms decide which references are implicit", () => {
  assert.deepEqual(messages("scopes.ts", `let count = 0;
const config = { debug: false };
const limit = 10;
function scale(n: number) { return limit * n + new Date(n).getTime(); }
function decrement() { count--; }
function configure(options: object) { Object.assign(config, options); }
function describe(level: number) { return { level, config }; }
function loop(items: number[]) { for (count of items) {} }
function unpack(pair: { a: number }) { ({ a: count } = pair); }
function unpackList(items: number[]) { [, count] = items; }
function blockLet(flag: boolean) { if (flag) { let count = 1; count++; } return count; }
function blockVar(flag: boolean) { if (flag) { var count = 1; } return count; }
function catchShadow() { try { return 1; } catch (count) { count = 2; return count; } }
const named = function count() { return count; };
function labelled() { document: for (;;) { break document; } }
function typed(value: typeof count) { return value; }
`), [
    "5:ImplicitInput: The function decrement() reads count, an implicit input.",
    "5:ImplicitOutput: The function decrement() writes count, an implicit output.",
    "6:ImplicitOutput: The function configure() writes config, an implicit output.",
    "7:ImplicitInput: The function describe() reads config, an implicit input.",
    "8:ImplicitOutput: The function loop() writes count, an implicit output.",
    "9:ImplicitOutput: The function unpack() writes count, an implicit output.",
    "10:ImplicitOutput: The function unpackList() writes count, an implicit output.",
    "11:ImplicitInput: The function blockLet() reads count, an implicit input.",
  ]);
});

test("a sink reached through the global object is an output, not a read of the global object", () => {
  assert.deepEqual(messages("global-sinks.js", `function notify(text) { window.alert(text); }
function later(callback) { globalThis.setTimeout(callback, 1); }
function log(text) { self.console.log(text); }
function width() { return window.innerWidth; }
`), [
    "1:ImplicitOutput: The function notify() uses alert, an implicit output.",
    "2:ImplicitOutput: The function later() uses setTimeout, an implicit output.",
    "3:ImplicitOutput: The function log() uses console, an implicit output.",
    "4:ImplicitInput: The function width() reads window, an implicit input.",
  ]);
});

test("sinks accessed via element access and parenthesized or asserted globals are outputs", () => {
  assert.deepEqual(messages("element-sinks.ts", `function f1() { window['alert']('hello'); }
function f2() { (window).alert('hello'); }
function f3() { globalThis['fetch']('/api'); }
function f4() { (globalThis as any).fetch('/api'); }
function f5() { (globalThis!).fetch('/api'); }
function f6() { window['console'].log('hello'); }
function f7() { self[\`queueMicrotask\`](() => {}); }
function f8() { (window as any)['alert']('hello'); }
function f9(k: string) { window[k]('hello'); }
function f10() { return window['innerWidth']; }
`), [
    "1:ImplicitOutput: The function f1() uses alert, an implicit output.",
    "2:ImplicitOutput: The function f2() uses alert, an implicit output.",
    "3:ImplicitOutput: The function f3() uses fetch, an implicit output.",
    "4:ImplicitOutput: The function f4() uses fetch, an implicit output.",
    "5:ImplicitOutput: The function f5() uses fetch, an implicit output.",
    "6:ImplicitOutput: The function f6() uses console, an implicit output.",
    "7:ImplicitOutput: The function f7() uses queueMicrotask, an implicit output.",
    "8:ImplicitOutput: The function f8() uses alert, an implicit output.",
    "9:ImplicitInput: The function f9() reads window, an implicit input.",
    "9:UnknownEffect: The function f9() calls unresolved callable, an unknown effect.",
    "10:ImplicitInput: The function f10() reads window, an implicit input.",
  ]);
});

test("every listed host object, sink, and nondeterministic call is recognised", () => {
  assert.deepEqual(messages("ambient-lists.js", `function hosts() { return [globalThis.a, localStorage.a, location.a, process.a, self.a, sessionStorage.a]; }
function sinks(callback) { queueMicrotask(callback); requestAnimationFrame(callback); setInterval(callback, 1); }
function random(buffer) { return [crypto.getRandomValues(buffer), crypto.randomUUID(), performance.now()]; }
`), [
    "1:ImplicitInput: The function hosts() reads globalThis, an implicit input.",
    "1:ImplicitInput: The function hosts() reads localStorage, an implicit input.",
    "1:ImplicitInput: The function hosts() reads location, an implicit input.",
    "1:ImplicitInput: The function hosts() reads process, an implicit input.",
    "1:ImplicitInput: The function hosts() reads self, an implicit input.",
    "1:ImplicitInput: The function hosts() reads sessionStorage, an implicit input.",
    "2:ImplicitOutput: The function sinks() uses queueMicrotask, an implicit output.",
    "2:ImplicitOutput: The function sinks() uses requestAnimationFrame, an implicit output.",
    "2:ImplicitOutput: The function sinks() uses setInterval, an implicit output.",
    "3:ImplicitInput: The function random() calls crypto.getRandomValues(), an implicit input.",
    "3:ImplicitInput: The function random() calls crypto.randomUUID(), an implicit input.",
    "3:ImplicitInput: The function random() calls performance.now(), an implicit input.",
  ]);
});

test("every listed mutating method mutates its receiver", () => {
  const methods = [
    "add", "append", "appendChild", "clear", "copyWithin", "delete", "fill", "insertBefore", "pop", "prepend", "push",
    "remove", "removeAttribute", "removeChild", "removeItem", "replaceChildren", "reverse", "set", "setAttribute",
    "setItem", "shift", "sort", "splice", "unshift", "write", "writeln",
  ];
  const source = methods.map((method) => `function ${method}Call(target) { target.${method}(); }\n`).join("");
  assert.deepEqual(messages("mutating-methods.js", source), methods.map((method, index) =>
    `${index + 1}:ImplicitOutput: The function ${method}Call() mutates argument target, an implicit output.`));
});

test("reads, calls, and operators that do not write are not outputs", () => {
  assert.deepEqual(messages("non-writes.ts", `let count = 0;
const config = { debug: false };
function bump() { count ^= 1; }
function negate() { return !count; }
function check(value: object) { return count in value || count instanceof Object; }
function keys() { return Object.keys(config); }
function pick(source: { count: number }) { const { count: value } = source; return value; }
function empty() { return String(); }
function schedule(run: (clock: () => number) => number) { return run(Date.now); }
function nudge(point: { x: number }) { point.x += 1; }
function shadowFunction() { function count() { return 1; } return count(); }
function caught() { try { return 1; } catch (count) { return 2; } finally { void count; } }
`), [
    "3:ImplicitInput: The function bump() reads count, an implicit input.",
    "3:ImplicitOutput: The function bump() writes count, an implicit output.",
    "4:ImplicitInput: The function negate() reads count, an implicit input.",
    "5:ImplicitInput: The function check() reads count, an implicit input.",
    "9:UnknownEffect: The function schedule() calls unresolved callable, an unknown effect.",
    "10:ImplicitOutput: The function nudge() mutates argument point, an implicit output.",
    "12:ImplicitInput: The function caught() reads count, an implicit input.",
  ]);
});

test("writes through parentheses and type assertions reach the written binding", () => {
  assert.deepEqual(messages("wrapped-writes.ts", `const config = { debug: false };
function paren() { (config).debug = true; }
function cast() { (config as { debug: boolean }).debug = true; }
function angle() { (<{ debug: boolean }>config).debug = true; }
`), [
    "2:ImplicitOutput: The function paren() writes config, an implicit output.",
    "3:ImplicitOutput: The function cast() writes config, an implicit output.",
    "4:ImplicitOutput: The function angle() writes config, an implicit output.",
  ]);
});

const classSource = `class Counter {
  constructor() { this.count = 0; }
  increment() { this.count += 1; return this.format(); }
  format() { return String(this.count); }
  self() { return this; }
}
`;

test("class state is an unknown effect by default", () => {
  assert.deepEqual(messages("class-default.js", classSource), [
    "3:UnknownEffect: The method Counter.increment() reads this.count, an unknown effect.",
    "3:UnknownEffect: The method Counter.increment() writes this.count, an unknown effect.",
    "4:UnknownEffect: The method Counter.format() reads this.count, an unknown effect.",
    "5:UnknownEffect: The method Counter.self() reads this, an unknown effect.",
  ]);
});

test("include-this reports class state reads and writes, but not method calls or constructors", () => {
  assert.deepEqual(messages("class-strict.js", classSource, strictRuleset), [
    "3:ImplicitInput: The method Counter.increment() reads this.count, an implicit input.",
    "3:ImplicitOutput: The method Counter.increment() writes this.count, an implicit output.",
    "4:ImplicitInput: The method Counter.format() reads this.count, an implicit input.",
    "5:ImplicitInput: The method Counter.self() reads this, an implicit input.",
  ]);
  assert.deepEqual(messages("class-after-strict.js", classSource), [
      "3:UnknownEffect: The method Counter.increment() reads this.count, an unknown effect.",
      "3:UnknownEffect: The method Counter.increment() writes this.count, an unknown effect.",
      "4:UnknownEffect: The method Counter.format() reads this.count, an unknown effect.",
      "5:UnknownEffect: The method Counter.self() reads this, an unknown effect.",
  ]);
});

test("include-this recognizes element-access members on this", () => {
  assert.deepEqual(messages("class-element-this.ts", `class Worker {
  count = 0;
  format() {}
  callString() { this["format"](); }
  callTemplate() { this[\`format\`](); }
  callDynamic(key: string) { this[key](); }
  readString() { return this["count"]; }
  readTemplate() { return this[\`count\`]; }
  writeString() { this["count"] = 1; }
  writeTemplate() { this[\`count\`] = 2; }
}
`, strictRuleset), [
    "7:ImplicitInput: The method Worker.readString() reads this.count, an implicit input.",
    "8:ImplicitInput: The method Worker.readTemplate() reads this.count, an implicit input.",
    "9:ImplicitOutput: The method Worker.writeString() writes this.count, an implicit output.",
    "10:ImplicitOutput: The method Worker.writeTemplate() writes this.count, an implicit output.",
  ]);
});

test("include-this treats this used as a key as a read of this, not a member call", () => {
  assert.deepEqual(messages("class-this-key.ts", `class Worker {
  run(handlers: Record<string, () => void>) { handlers[this](); }
}
`, strictRuleset), [
    "2:ImplicitInput: The method Worker.run() reads this, an implicit input.",
  ]);
});

test("include-this unwraps wrapped this receivers before classifying member reads and writes", () => {
  const findings = messages("class-wrapped-this.ts", `class Worker {
  state = 0;
  helper() {}
  parenthesizedCall() { (this).helper(); }
  nonNullCall() { this!.helper(); }
  asCall() { (this as Worker).helper(); }
  satisfiesCall() { (this satisfies Worker).helper(); }
  parenthesizedWrite() { (this).state = 1; }
  nonNullWrite() { this!.state = 1; }
  asWrite() { (this as Worker).state = 1; }
  satisfiesWrite() { (this satisfies Worker).state = 1; }
}
`, strictRuleset).map((finding) => finding.replace(/^\d+:/, ""));

  assert.deepEqual(findings, [
    "ImplicitOutput: The method Worker.parenthesizedWrite() writes this.state, an implicit output.",
    "ImplicitOutput: The method Worker.nonNullWrite() writes this.state, an implicit output.",
    "ImplicitOutput: The method Worker.asWrite() writes this.state, an implicit output.",
    "ImplicitOutput: The method Worker.satisfiesWrite() writes this.state, an implicit output.",
  ]);
});

test("the recommended typescript policy does not include the explicitness rules", () => {
  const found = messages("policy.js", `let total = 0;
function add(amount) { total += amount; }
`, "typescript");
  assert.deepEqual(found.filter((message) => message.includes("Implicit")), []);
});

test("closure over a per-iteration let loop variable is not an implicit input when mutated only in loop update", () => {
  assert.deepEqual(messages("loop-closure.js", `export function handlers(n) {
  const hs = [];
  for (let i = 0; i < n; i++) {
    hs.push(() => i);
  }
  return hs;
}
`), []);

  assert.deepEqual(messages("loop-variants.js", `export function variants(n) {
  const hs = [];
  for (let i = 0; i < n; i += 1) {
    hs.push(() => i);
  }
  for (let j = 0; j < n; ++j) {
    hs.push(() => j);
  }
  for (let k = 0; k < n; k = k + 1) {
    hs.push(() => k);
  }
  for (let a = 0, b = 0; a < n; a++, b += 2) {
    hs.push(() => a + b);
  }
  return hs;
}
`), []);
});

test("nested functions and callbacks reading a per-iteration loop variable have no finding", () => {
  assert.deepEqual(messages("nested-loop-closure.js", `export function create(n) {
  const hs = [];
  for (let i = 0; i < n; i++) {
    function factory() {
      return () => i;
    }
    hs.push(factory());
  }
  return hs;
}
`), []);
});

test("closures capturing a loop variable mutated in the loop body still report ImplicitInput", () => {
  assert.deepEqual(messages("loop-body-mutation.js", `export function bodyMutation(n) {
  const hs = [];
  for (let i = 0; i < n; i++) {
    i++;
    hs.push(() => i);
  }
  return hs;
}
`), [
    "5:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
  ]);

  assert.deepEqual(messages("loop-body-reassign.js", `export function bodyReassign(n) {
  const hs = [];
  for (let i = 0; i < n; i++) {
    i = 0;
    hs.push(() => i);
  }
  return hs;
}
`), [
    "5:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
  ]);

  assert.deepEqual(messages("loop-nested-mutation.js", `export function nestedMutation(n) {
  const hs = [];
  for (let i = 0; i < n; i++) {
    function mutate() { i++; }
    hs.push(() => i);
  }
  return hs;
}
`), [
    "4:ImplicitInput: The function mutate() reads i, an implicit input.",
    "4:ImplicitOutput: The function mutate() writes i, an implicit output.",
    "5:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
  ]);

  assert.deepEqual(messages("loop-incrementor-closure-mutation.js", `export function incClosureMutation(n) {
  const hs = [];
  for (let i = 0; i < n; (() => { i++; })()) {
    hs.push(() => i);
  }
  return hs;
}
`), [
    "3:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
    "3:ImplicitOutput: The arrow function anonymous() writes i, an implicit output.",
    "4:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
  ]);

  assert.deepEqual(messages("loop-toplevel-mutation.js", `for (let i = 0; i < 10; i++) {
  i++;
  const f = () => i;
}
`), [
    "3:ImplicitInput: The arrow function f() reads i, an implicit input.",
  ]);
});

test("closures capturing a var loop variable or loop variable declared outside continue to report ImplicitInput", () => {
  assert.deepEqual(messages("var-loop.js", `export function varHandlers(n) {
  const hs = [];
  for (var i = 0; i < n; i++) {
    hs.push(() => i);
  }
  return hs;
}
`), [
    "4:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
  ]);

  assert.deepEqual(messages("outer-loop-var.js", `export function outerHandlers(n) {
  const hs = [];
  let i;
  for (i = 0; i < n; i++) {
    hs.push(() => i);
  }
  return hs;
}
`), [
    "5:ImplicitInput: The arrow function anonymous() reads i, an implicit input.",
  ]);
});

test("collectImplicitFlows caches analysis per SourceFile and reuses results when options match", () => {
  const file = ts.createSourceFile("cache-test.ts", `
let total = 0;
class Counter {
  count = 0;
  increment() {
    this.count++;
    total++;
  }
}
`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Calling with false caches result
  const withoutThis1 = collectImplicitFlows(file, false);
  const withoutThis2 = collectImplicitFlows(file, false);
  assert.equal(withoutThis1, withoutThis2);

  // Calling without second argument defaults to includeThis: false and reuses cache
  const defaultCall = collectImplicitFlows(file);
  assert.equal(defaultCall, withoutThis1);

  // Calling with true caches separately
  const withThis1 = collectImplicitFlows(file, true);
  const withThis2 = collectImplicitFlows(file, true);
  assert.equal(withThis1, withThis2);
  assert.notEqual(withThis1, withoutThis1);

  // Distinct SourceFile instances produce distinct cached entries
  const file2 = ts.createSourceFile("cache-test-2.ts", `let total = 0; function f() { total++; }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const file2Flows = collectImplicitFlows(file2, false);
  assert.notEqual(file2Flows, withoutThis1);
});

test("findImplicitInput and findImplicitOutput reuse cached collectImplicitFlows results", () => {
  const file = ts.createSourceFile("rules-cache.ts", `
let total = 0;
function f() {
  total++;
}
`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const inputs = findImplicitInput(file);
  const outputs = findImplicitOutput(file);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].message, /reads total/);
  assert.equal(outputs.length, 1);
  assert.match(outputs[0].message, /writes total/);

  // Directly check that collectImplicitFlows(file, false) returns the same cached flows
  const cachedFlows = collectImplicitFlows(file, false);
  assert.equal(cachedFlows.length, 2);
  assert.deepEqual(cachedFlows.map((f) => f.description).sort(), ["reads total", "writes total"]);
});

test("a default value in a shorthand destructuring assignment reads the outer binding", () => {
  assert.deepEqual(messages("shorthand.js", `let fallback = 0;
fallback++;
function pick(source) {
  let a;
  ({ a = fallback } = source);
  return a;
}
`), [
    "2:ImplicitInput: The module reads fallback, an implicit input.",
    "2:ImplicitOutput: The module writes fallback, an implicit output.",
    "5:ImplicitInput: The function pick() reads fallback, an implicit input.",
  ]);
});

test("an alias of an argument retains caller ownership", () => {
  assert.deepEqual(messages("alias.ts", `function change(values: number[]) {
  const alias = values;
  alias.push(1);
}
`), ["3:ImplicitOutput: The function change() mutates caller-owned value alias, an implicit output."]);

  assert.deepEqual(messages("returned-alias.ts", `function alias(values: number[]) {
  return values;
}
function direct(values: number[]) {
  alias(values).push(1);
}
function indirect(values: number[]) {
  const output = alias(values);
  output.push(1);
}
`), [
    "5:ImplicitOutput: The function direct() mutates argument values, an implicit output.",
    "9:ImplicitOutput: The function indirect() mutates caller-owned value output, an implicit output.",
  ]);
});

test("a fresh replacement is private and a conditional replacement is not proof", () => {
  assert.deepEqual(messages("copy.ts", `function change(values: number[]) {
  values = [...values];
  values.push(1);
  return values;
}
`), []);
  assert.deepEqual(messages("conditional-copy.ts", `function change(values: number[], copy: boolean) {
  if (copy) { values = [...values]; }
  values.push(1);
}
`), ["3:ImplicitOutput: The function change() mutates argument values, an implicit output."]);
});

test("known effects propagate through transitive and recursive calls", () => {
  assert.deepEqual(messages("propagation.ts", `function leaf(value: number) { console.log(value); }
function middle(value: number) { leaf(value); }
function wrapper(value: number) { middle(value); }
`), [
    "1:ImplicitOutput: The function leaf() uses console, an implicit output.",
    "2:ImplicitOutput: The function middle() uses console, an implicit output.",
    "3:ImplicitOutput: The function wrapper() uses console, an implicit output.",
  ]);

  assert.deepEqual(messages("recursive-pure.ts", `function loop(value: number): number {
  return value <= 0 ? 0 : loop(value - 1);
}
`), []);
});

test("unknown callback effects propagate without fabricating input or output", () => {
  assert.deepEqual(messages("unknown-propagation.ts", `function leaf(value: number, notify: (value: number) => number) {
  return notify(value);
}
function wrapper(value: number, notify: (value: number) => number) {
  return leaf(value, notify);
}
`), [
    "2:UnknownEffect: The function leaf() calls unresolved callable, an unknown effect.",
    "5:UnknownEffect: The function wrapper() calls unresolved callable, an unknown effect.",
  ]);
});

test("known callback arguments replace parameter-relative unknown effects", () => {
  assert.deepEqual(messages("known-callback.ts", `function apply(value: number, calculate: (value: number) => number) {
  return calculate(value);
}
function pure(value: number) {
  return value + 1;
}
function wrapper(value: number) {
  return apply(value, pure);
}
`), [
    "2:UnknownEffect: The function apply() calls unresolved callable, an unknown effect.",
  ]);

  assert.deepEqual(messages("known-callback-action.ts", `function apply(value: number, effect: (value: number) => void) {
  effect(value);
}
function write(value: number) {
  console.log(value);
}
function wrapper(value: number) {
  apply(value, write);
}
`), [
    "2:UnknownEffect: The function apply() calls unresolved callable, an unknown effect.",
    "5:ImplicitOutput: The function write() uses console, an implicit output.",
    "8:ImplicitOutput: The function wrapper() uses console, an implicit output.",
  ]);
});

test("known callback writes instantiate against the caller argument storage", () => {
  assert.deepEqual(messages("known-callback-write.ts", `function apply(values: number[], change: (values: number[]) => void) {
  change(values);
}
function push(values: number[]) {
  values.push(1);
}
function wrapper(values: number[]) {
  apply(values, push);
}
`), [
    "2:UnknownEffect: The function apply() calls unresolved callable, an unknown effect.",
    "5:ImplicitOutput: The function push() mutates argument values, an implicit output.",
    "8:ImplicitOutput: The function wrapper() mutates argument values, an implicit output.",
  ]);
});

test("parameter write summaries preserve argument identity and missing-argument uncertainty", () => {
  assert.deepEqual(messages("parameter-summary.ts", `function writeSecond(first: number[], second: number[]) {
  second.push(1);
}
function caller(first: number[], second: number[]) {
  writeSecond([], second);
}
function omitted(first: number[]) {
  writeSecond(first);
}
`), [
    "2:ImplicitOutput: The function writeSecond() mutates argument second, an implicit output.",
    "5:ImplicitOutput: The function caller() mutates argument second, an implicit output.",
    "8:UnknownEffect: The function omitted() calls writable parameter without an argument, an unknown effect.",
  ]);

  assert.deepEqual(messages("parameter-summary-storage.ts", `const shared: number[] = [];
declare function load(): number[];
function mutate(values: number[]) {
  values.push(1);
}
function writeShared() {
  mutate(shared);
}
function writeUnknown() {
  mutate(load());
}
`), [
    "4:ImplicitOutput: The function mutate() mutates argument values, an implicit output.",
    "7:ImplicitOutput: The function writeShared() mutates caller-owned value shared, an implicit output.",
    "7:ImplicitInput: The function writeShared() reads shared, an implicit input.",
    "10:UnknownEffect: The function writeUnknown() mutates value with unknown ownership, an unknown effect.",
    "10:UnknownEffect: The function writeUnknown() calls unresolved callable, an unknown effect.",
  ]);
});

test("known callbacks passed through a parameter stay unknown only until resolved by a caller", () => {
  assert.deepEqual(messages("forwarded-known-callback.ts", `function apply(value: number, calculate: (value: number) => number) {
  return calculate(value);
}
function forward(value: number, calculate: (value: number) => number) {
  return apply(value, calculate);
}
function pure(value: number) {
  return value + 1;
}
function wrapper(value: number) {
  return forward(value, pure);
}
`), [
    "2:UnknownEffect: The function apply() calls unresolved callable, an unknown effect.",
    "5:UnknownEffect: The function forward() calls unresolved callable, an unknown effect.",
  ]);

  assert.deepEqual(messages("callback-storage-summary.ts", `const shared: number[] = [];
declare function load(): number[];
function apply(values: number[], change: (values: number[]) => void) {
  change(values);
}
function push(values: number[]) {
  values.push(1);
}
function sharedWrite() {
  apply(shared, push);
}
function unknownWrite() {
  apply(load(), push);
}
function missingCallback(values: number[]) {
  apply(values);
}
`), [
    "4:UnknownEffect: The function apply() calls unresolved callable, an unknown effect.",
    "7:ImplicitOutput: The function push() mutates argument values, an implicit output.",
    "10:ImplicitOutput: The function sharedWrite() mutates caller-owned callback argument, an implicit output.",
    "10:ImplicitInput: The function sharedWrite() reads shared, an implicit input.",
    "13:UnknownEffect: The function unknownWrite() mutates value with unknown ownership, an unknown effect.",
    "13:UnknownEffect: The function unknownWrite() calls unresolved callable, an unknown effect.",
    "16:UnknownEffect: The function missingCallback() calls unresolved callable, an unknown effect.",
  ]);
});

test("unknown storage joined with caller storage keeps both facts without extra output kinds", () => {
  assert.deepEqual(messages("mixed-ownership.ts", `declare function choose(): { n: number }[];
function change(values: { n: number }[], flag: boolean) {
  const target = flag ? values : choose();
  target[0].n = 1;
}
`), [
    "3:UnknownEffect: The function change() calls unresolved callable, an unknown effect.",
    "4:ImplicitOutput: The function change() mutates caller-owned value target, an implicit output.",
    "4:UnknownEffect: The function change() mutates value with unknown ownership, an unknown effect.",
  ]);
});

test("deferred callback creation stays on the callback owner and immediate invocation propagates", () => {
  assert.deepEqual(messages("factory-callback.ts", `function make(notify: (value: number) => void) {
  return (value: number) => notify(value);
}
`), [
    "2:UnknownEffect: The arrow function anonymous() calls unresolved callable, an unknown effect.",
  ]);

  assert.deepEqual(messages("invoke-callback.ts", `function run(notify: (value: number) => void) {
  const callback = (value: number) => notify(value);
  callback(1);
}
`), [
    "2:UnknownEffect: The arrow function callback() calls unresolved callable, an unknown effect.",
    "3:UnknownEffect: The function run() calls unresolved callable, an unknown effect.",
  ]);
});

test("fixed captures and private top-level calculations stay quiet while module state writes report", () => {
  assert.deepEqual(messages("fixed-capture.ts", `function makeAdder(start: number) {
  return (value: number) => start + value;
}
`), []);

  assert.deepEqual(messages("private-local.ts", `const cache: number[] = [];
function localOnly(value: number) {
  const values: number[] = [];
  values.push(value);
}
function remember(value: number) {
  cache.push(value);
}
`), [
    "7:ImplicitOutput: The function remember() writes cache, an implicit output.",
  ]);
});

test("shallow copies keep shared elements but fresh outers and rebinding stay private", () => {
  assert.deepEqual(messages("shallow-elements.ts", `function change(values: { n: number }[]) {
  const next = [...values];
  next.push({ n: 0 });
  next[0].n = 1;
}
`), [
    "4:ImplicitOutput: The function change() mutates caller-owned value next, an implicit output.",
  ]);

  assert.deepEqual(messages("alias-rebinding.ts", `function before(values: number[]) {
  const alias = values;
  values = [];
  alias.push(1);
  values.push(2);
}
function after(values: number[]) {
  values = [];
  const alias = values;
  alias.push(1);
}
`), [
    "4:ImplicitOutput: The function before() mutates caller-owned value alias, an implicit output.",
  ]);

  assert.deepEqual(messages("object-member-alias.ts", `function change(values: number[]) {
  const box = { items: values };
  const alias = box.items;
  alias.push(1);
}
`), [
    "4:ImplicitOutput: The function change() mutates caller-owned value alias, an implicit output.",
  ]);
});

test("literal false branches do not execute known, unknown, or storage effects", () => {
  assert.deepEqual(messages("dead-known-action.ts", `function calculate(value: number) {
  if (false) { console.log(value); }
  return value;
}
function run(value: number) {
  if (true) { console.log(value); } else { return value; }
}
`), [
    "6:ImplicitOutput: The function run() uses console, an implicit output.",
  ]);

  assert.deepEqual(messages("dead-unknown-action.ts", `function calculate(value: number, notify: (value: number) => void) {
  if (false) { notify(value); }
  return value;
}
function run(value: number, notify: (value: number) => void) {
  if (true) { notify(value); }
}
`), [
    "6:UnknownEffect: The function run() calls unresolved callable, an unknown effect.",
  ]);

  assert.deepEqual(messages("dead-storage-action.ts", `const cache: number[] = [];
if (false) { cache.push(1); }
function read() {
  return cache.length;
}
function calculate(values: number[]) {
  if (false) { values.push(1); }
  return values.length;
}
`), []);

  assert.deepEqual(messages("dead-conditional-action.ts", `function calculate(value: number, notify: (value: number) => void) {
  return false ? notify(value) : value;
}
function run(value: number, notify: (value: number) => void) {
  return true ? notify(value) : value;
}
`), [
    "5:UnknownEffect: The function run() calls unresolved callable, an unknown effect.",
  ]);
});

function effectSites(name, source) {
  const path = join(workspace, name);
  writeFileSync(path, source);
  const stdout = captureOutput();
  const stderr = captureOutput();
  runCliInProcess([path, "json", "explicitness", "--strict"], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(stderr.read(), "");
  const report = JSON.parse(stdout.read());
  assert.deepEqual(report.errors, []);
  return report.findings.map(({ line, ruleName, context }) => [line, ruleName, context]);
}

test("module writes and exported container reads have distinct owners", () => {
  assert.deepEqual(effectSites("module-export.ts", `export const OFFSET = [0];
console.log("loaded");
function add(value: number) {
  return value + OFFSET[0];
}
`), [
    [2, "ImplicitOutput", "<module>"],
    [4, "ImplicitInput", "function add()"],
  ]);
  assert.deepEqual(effectSites("exported-scalar.ts", `export const OFFSET = 1;
function add(value: number) { return value + OFFSET; }
`), []);
});

test("returned closures instantiate captured argument storage at their invocation", () => {
  assert.deepEqual(effectSites("factory-storage.ts", `function make(values: number[]) {
  const alias = values;
  return () => alias.push(1);
}
function privateCall() {
  const later = make([]);
  later();
}
function caller(values: number[]) {
  make(values)();
}
`), [
    [3, "ImplicitOutput", "arrow function anonymous()"],
    [10, "ImplicitOutput", "function caller()"],
  ]);
});

test("callback effects follow branch assignments and renamed forwarders", () => {
  assert.deepEqual(effectSites("callback-branches.ts", `function inner(values: number[], change: (values: number[]) => void) {
  change(values);
}
function outer(values: number[], renamed: (values: number[]) => void) {
  inner(values, renamed);
}
function mutate(values: number[]) {
  values.push(1);
}
function caller(values: number[], condition: boolean) {
  let change = (values: number[]) => values.length;
  if (condition) { change = mutate; }
  outer(values, change);
}
function privateCall() { outer([], mutate); }
`), [
    [2, "UnknownEffect", "function inner()"],
    [5, "UnknownEffect", "function outer()"],
    [8, "ImplicitOutput", "function mutate()"],
    [13, "ImplicitOutput", "function caller()"],
  ]);
});

test("known library callback effects replace injected callback uncertainty", () => {
  assert.deepEqual(effectSites("library-callback.ts", `function apply(value: number, act: (value: number) => void) {
  act(value);
}
function write(value: number) { apply(value, console.log); }
function pure(value: number) { apply(value, Math.abs); }
`), [
    [2, "UnknownEffect", "function apply()"],
    [4, "ImplicitOutput", "function write()"],
  ]);
});

test("standard callback methods execute named and anonymous callback bodies", () => {
  assert.deepEqual(effectSites("library-method-callbacks.ts", `function write(value: number) { console.log(value); return value; }
function caller(values: number[]) {
  values.some(write);
  values.filter((value) => { console.log(value); return true; });
  values.map(write);
  values.reduce((sum, value) => { console.log(value); return sum + value; }, 0);
  values.slice().sort((left, right) => { console.log(left); return left - right; });
}
`), [
    [1, "ImplicitOutput", "function write()"],
    [3, "ImplicitOutput", "function caller()"],
    [4, "ImplicitOutput", "arrow function anonymous()"],
    [6, "ImplicitOutput", "arrow function anonymous()"],
    [7, "ImplicitOutput", "arrow function anonymous()"],
  ]);
});

test("a standard method name needs a known standard receiver", () => {
  assert.deepEqual(effectSites("standard-receivers.ts", `interface Lookup { get(key: string): number; }
function unknown(value: Lookup) { return value.get("key"); }
function map(value: ReadonlyMap<string, number>) { return value.get("key"); }
function strings(value: string) { return value.trim().slice(1); }
function arrays(value: number[]) { return value.slice().map(item => item + 1); }
function joined(flag: boolean, left: number[], right: number[]) {
  const value = flag ? left : right;
  return value.slice();
}
function custom(flag: boolean, left: number[], right: Lookup) {
  const value = flag ? left : right;
  return value.toString();
}
`), [
    [2, "UnknownEffect", "function unknown()"],
    [12, "UnknownEffect", "function custom()"],
  ]);
});

test("local type declarations cannot impersonate standard receivers", () => {
  assert.deepEqual(effectSites("shadowed-receiver-types.ts", `interface Array { toString(): string; }
function shadowed(value: Array) { return value.toString(); }
function generic<Array>(value: Array) { return value.toString(); }
type Numbers = number[];
function alias(value: Numbers) { return value.slice(); }
`), [
    [2, "UnknownEffect", "function shadowed()"],
    [3, "UnknownEffect", "function generic()"],
  ]);
});

test("copy rebinding preserves standard receiver facts and private writes", () => {
  assert.deepEqual(effectSites("copy-rebinding.ts", `function pure(items: number[]) {
  items = items.slice();
  items.push(2);
  return items;
}
function action(items: number[]) {
  items.push(2);
  items = items.slice();
  items.push(2);
  return items;
}
function local() {
  let items = [1];
  items = items.slice();
  return items.slice();
}
`), [
    [7, "ImplicitOutput", "function action()"],
  ]);
});

test("mapped and reduced values retain caller storage through callback returns", () => {
  assert.deepEqual(effectSites("mapped-storage.ts", `function mapped(values: number[][]) {
  const copy = values.map((value) => value);
  copy[0].push(1);
}
function reduced(values: number[][], target: number[]) {
  const output = values.reduce((sum, value) => value, target);
  output.push(1);
}
function privateMap(values: number[]) {
  const output = values.map((value) => [value]);
  output[0].push(1);
}
`), [
    [3, "ImplicitOutput", "function mapped()"],
    [7, "ImplicitOutput", "function reduced()"],
  ]);
});

test("hot async calls transfer at the call and native Promise waits stay quiet", () => {
  assert.deepEqual(effectSites("hot-async.ts", `async function stamp() {
  await Promise.resolve(0);
  return Date.now();
}
async function run() {
  const pending = stamp();
  return await pending;
}
async function identity(pending: Promise<number>) { return await pending; }
async function pure() { return 1; }
`), [
    [3, "ImplicitInput", "function stamp()"],
    [6, "ImplicitInput", "function run()"],
  ]);
});

test("async closures start at invocation while their factory stays quiet", () => {
  assert.deepEqual(effectSites("async-factory.ts", `function make() {
  return async () => Date.now();
}
async function run() {
  const later = make();
  return await later();
}
`), [
    [2, "ImplicitInput", "arrow function anonymous()"],
    [6, "ImplicitInput", "function run()"],
  ]);
});

test("generator bodies transfer at iteration and next calls, not creation", () => {
  assert.deepEqual(effectSites("cold-generators.ts", `function* lines() {
  yield Date.now();
}
function make() { return lines(); }
function collect() {
  const iterator = lines();
  const alias = iterator;
  for (const line of alias) { return line; }
}
function next() {
  const iterator = lines();
  return iterator.next();
}
function direct() { return [...lines()]; }
function from() { return Array.from(lines()); }
`), [
    [2, "ImplicitInput", "function lines()"],
    [8, "ImplicitInput", "function collect()"],
    [12, "ImplicitInput", "function next()"],
    [14, "ImplicitInput", "function direct()"],
    [15, "ImplicitInput", "function from()"],
  ]);
});

test("ordinary containers are quiet and unresolved iterator or conversion hooks are unknown", () => {
  assert.deepEqual(effectSites("value-protocols.ts", `function ordinary(values: number[], text: string) { return [...values, ...text]; }
function iterator(values: Iterable<number>) { return [...values]; }
function loop(values: Iterable<number>) { for (const value of values) { return value; } }
function convert(value: object) { return \`value: \${value}\`; }
function scalar(value: number) { return \`value: \${value}\`; }
async function thenable(value: { then: Function }) { return await value; }
`), [
    [2, "UnknownEffect", "function iterator()"],
    [3, "UnknownEffect", "function loop()"],
    [4, "UnknownEffect", "function convert()"],
    [6, "UnknownEffect", "function thenable()"],
  ]);
});

test("defaults execute only for missing or possibly undefined arguments", () => {
  assert.deepEqual(effectSites("default-invocations.ts", `function stamp(value: number, time = Date.now()) { return value + time; }
function missing(value: number) { return stamp(value); }
function given(value: number) { return stamp(value, 0); }
function explicitUndefined(value: number) { return stamp(value, undefined); }
function spread(values: number[]) { return stamp(...values); }
`), [
    [1, "ImplicitInput", "function stamp()"],
    [2, "ImplicitInput", "function missing()"],
    [4, "ImplicitInput", "function explicitUndefined()"],
    [5, "ImplicitInput", "function spread()"],
  ]);
});

test("class construction transfers fields and inherited argument writes", () => {
  assert.deepEqual(effectSites("constructor-effects.ts", `class Base {
  constructor(values: number[]) { values.push(1); }
}
class Derived extends Base {
  stamp = Date.now();
}
function caller(values: number[]) { return new Derived(values); }
function privateCall() { return new Base([]); }
`), [
    [2, "ImplicitOutput", "constructor"],
    [4, "ImplicitOutput", "constructor"],
    [5, "ImplicitInput", "constructor"],
    [7, "ImplicitInput", "function caller()"],
    [7, "ImplicitOutput", "function caller()"],
  ]);
});

test("static fields execute at definition while instance fields execute on construction", () => {
  assert.deepEqual(effectSites("field-lifecycle.ts", `function define() {
  class Clock {
    static now = Date.now();
    stamp = Math.random();
  }
  return Clock;
}
class Local {
  stamp = Date.now();
}
function create() { return new Local(); }
`), [
    [3, "ImplicitInput", "function define()"],
    [4, "ImplicitInput", "constructor"],
    [9, "ImplicitInput", "constructor"],
    [11, "ImplicitInput", "function create()"],
  ]);
});

test("method dispatch follows local receiver shapes and subclass overrides", () => {
  assert.deepEqual(effectSites("class-dispatch.ts", `class Base {
  run() { return this.effect(); }
  effect() { return 1; }
}
class Derived extends Base {
  constructor() { super(); }
  effect() { console.log(1); return 1; }
}
function caller() { return new Derived().run(); }
`), [
    [2, "ImplicitOutput", "method Base.run()"],
    [7, "ImplicitOutput", "method Derived.effect()"],
    [9, "ImplicitOutput", "function caller()"],
  ]);
});

test("accessors and tagged templates transfer their executable bodies", () => {
  assert.deepEqual(effectSites("accessors-tags.ts", `class Counter {
  get value() { console.log("read"); return 1; }
  set value(value: number) { console.log(value); }
}
function tag(parts: TemplateStringsArray, value: number) { console.log(value); return value; }
function caller() {
  const counter = new Counter();
  counter.value++;
  return tag\`value \${counter.value}\`;
}
`), [
    [2, "ImplicitOutput", "accessor Counter.value()"],
    [3, "ImplicitOutput", "accessor Counter.value()"],
    [5, "ImplicitOutput", "function tag()"],
    [8, "ImplicitOutput", "function caller()"],
  ]);
});

test("shorthand holders keep reachable storage shared while copied outers are private", () => {
  assert.deepEqual(effectSites("holding-shorthand.ts", `function hold(values: number[]) {
  const holder = { values };
  holder.values.push(1);
}
function copy(values: number[]) {
  const copied = Array.from(values);
  copied.push(1);
  return copied;
}
`), [[3, "ImplicitOutput", "function hold()"]]);
});

test("Date calls read the clock even with arguments while explicit construction is quiet", () => {
  assert.deepEqual(effectSites("date-call.ts", `function clock() {
  return Date(1);
}
function fixed() {
  return new Date(1).getTime();
}
`), [[2, "ImplicitInput", "function clock()"]]);
});

test("copied scalar elements have private storage across supported array type shapes", () => {
  assert.deepEqual(effectSites("scalar-elements.ts", `function scalar(value: number | string) {
  const copy = { value };
  copy.value = 1;
}
function tuple(values: [number, string]) {
  const copy = values.map(value => [value]);
  copy[0].push(1);
}
function named(values: [value: number]) {
  const copy = values.map(value => [value]);
  copy[0].push(1);
}
function generic(values: Array<number>) {
  const copy = values.map(value => [value]);
  copy[0].push(1);
}
function readOnly(values: readonly number[]) {
  const copy = values.map(value => [value]);
  copy[0].push(1);
}
function union(values: number[] | string[]) {
  const copy = values.map(value => [value]);
  copy[0].push(1);
}
function nested(values: number[][]) {
  const copy = values.map(value => value);
  copy[0].push(1);
}
`), [[27, "ImplicitOutput", "function nested()"]]);
});

test("standard protocol type names honor local interfaces and type parameters", () => {
  assert.deepEqual(effectSites("shadowed-protocols.ts", `interface Promise<T> {
  then(callback: (value: T) => unknown): unknown;
}
interface Array<T> {
  [Symbol.iterator](): Iterator<T>;
}
async function awaitCustom(value: Promise<number>) {
  return await value;
}
function iterateCustom(value: Array<number>) {
  return [...value];
}
async function awaitGeneric<Promise>(value: Promise) {
  return await value;
}
function iterateGeneric<Array>(value: Array) {
  return [...value];
}
export {};
`), [
    [8, "UnknownEffect", "function awaitCustom()"],
    [11, "UnknownEffect", "function iterateCustom()"],
    [14, "UnknownEffect", "function awaitGeneric()"],
    [17, "UnknownEffect", "function iterateGeneric()"],
  ]);
});

test("protocol aliases retain native operations and unresolved thenables", () => {
  assert.deepEqual(effectSites("aliased-protocols.ts", `type Native = Promise<number>;
type Values = readonly number[];
type Custom = PromiseLike<number>;
async function native(value: Native) {
  return await value;
}
function values(value: Values) {
  return [...value];
}
async function custom(value: Custom) {
  return await value;
}
`), [[11, "UnknownEffect", "function custom()"]]);
});

test("protocols follow operand values returned by logical, comma, and assignment expressions", () => {
  assert.deepEqual(effectSites("protocol-operand-values.ts", `async function logical(value: PromiseLike<number>) {
  return await (value || value);
}
async function nativeLogical(value: Promise<number>) {
  return await (value || value);
}
async function comma(value: PromiseLike<number>) {
  return await (0, value);
}
async function nativeComma(value: Promise<number>) {
  return await (0, value);
}
async function assignment(value: PromiseLike<number>) {
  return await (value = value);
}
async function nativeAssignment(value: Promise<number>) {
  return await (value = value);
}
`), [
    [2, "UnknownEffect", "function logical()"],
    [8, "UnknownEffect", "function comma()"],
    [14, "UnknownEffect", "function assignment()"],
  ]);
});

function ownerRecords(name, source) {
  const path = join(workspace, name);
  writeFileSync(path, source);
  const stdout = captureOutput();
  const stderr = captureOutput();
  runCliInProcess([path, "json", "explicitness", "--strict"], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(stderr.read(), "");
  const report = JSON.parse(stdout.read());
  assert.deepEqual(report.errors, []);
  return report.findings.filter((finding) => finding.context === "function run()")
    .map((finding) => [finding.line, finding.ruleName]);
}

test("scalar container storage honors lexical Array and ReadonlyArray bindings", () => {
  const cases = [
    ["shadow-array-storage.ts", "interface Array<T> {\n  [index: number]: number[];\n}\nfunction run(items: Array<number>) {\n  items[0].push(1);\n}\nexport {};\n", [[5,"ImplicitOutput"]]],
    ["shadow-readonlyarray-storage.ts", "interface ReadonlyArray<T> {\n  [index: number]: number[];\n}\nfunction run(items: ReadonlyArray<number>) {\n  items[0].push(1);\n}\nexport {};\n", [[5,"ImplicitOutput"]]],
    ["native-number-array-copy.ts", "function run(items: Array<number>) {\n  const copy = items.map(item => [item]);\n  copy[0].push(1);\n  return copy;\n}\nexport {};\n", []],
    ["native-nested-array-write.ts", "function run(items: Array<number[]>) {\n  const copy = items.slice();\n  copy[0].push(1);\n}\n", [[3,"ImplicitOutput"]]]
  ];
  for (const [name, source, expected] of cases) {
    const actual = ownerRecords(name, source);
    if (expected.length === 0) assert.deepEqual(actual, [], name);
    else for (const finding of expected) assert.ok(actual.some((item) => item[0] === finding[0] && item[1] === finding[1]), name + ": " + JSON.stringify(actual));
  }
});

test("late container insertions preserve reached caller storage", () => {
  const cases = [
    ["factory-independent-holders.ts", "function make(): { items: number[] } { return { items: [] }; }\nfunction run(items: number[]) {\n  const shared = make();\n  const privateBox = make();\n  shared.items = items;\n  privateBox.items.push(1);\n}\n", []],
    ["callback-holder-insertion.ts", "function run(items: number[]) {\n  const box: number[][] = [];\n  [0].forEach(() => box.push(items));\n  box[0].push(1);\n}\n", [[4, "ImplicitOutput"]]],
    ["record-reference-replaced.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  box.items = [];\n  box.items.push(1);\n}\n", []],
    ["alias-reference-replaced.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  const alias = box;\n  alias.items = [];\n  box.items.push(1);\n}\n", []],
    ["conditional-reference-replaced.ts", "function run(items: number[], flag: boolean) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  if (flag) { box.items = []; }\n  box.items.push(1);\n}\n", [[5, "ImplicitOutput"]]],
    ["map-reference-replaced.ts", "function run(items: number[]) {\n  const box = new Map<string, number[]>();\n  box.set(\"key\", items);\n  box.set(\"key\", []);\n  box.get(\"key\")?.push(1);\n}\n", []],
    ["assign-reference-replaced.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  Object.assign(box, { items });\n  Object.assign(box, { items: [] });\n  box.items.push(1);\n}\n", []],
    ["assign-repeated-source-order.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  Object.assign(box, { items }, { items: [] }, { items });\n  box.items.push(1);\n}\n", [[4, "ImplicitOutput"]]],
    ["uncalled-setter-holder.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  const set = () => { box.items = items; };\n  box.items.push(1);\n  return set;\n}\n", []],
    ["cold-callback-holder.ts", "function run(items: number[]) {\n  const box: number[][] = [[]];\n  [0].forEach(function* () { box.push(items); });\n  box[0].push(1);\n}\n", []],
    ["callback-private-holder.ts", "function run() {\n  const box: number[][] = [];\n  [0].forEach(() => box.push([]));\n  box[0].push(1);\n}\n", []],
    ["helper-reference-replaced.ts", "function replace(box: { items: number[] }) { box.items = []; }\nfunction run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  replace(box);\n  box.items.push(1);\n}\n", []],
    ["array-reference-replaced.ts", "function run(items: number[]) {\n  const box: number[][] = [];\n  box[0] = items;\n  box[0] = [];\n  box[0].push(1);\n}\n", []],
    ["holder-member-snapshot.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  const alias = box.items;\n  box.items = [];\n  alias.push(1);\n}\n", [[6, "ImplicitOutput"]]],
    ["object-holder-late-write.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  box.items.push(1);\n}\n", [[4,"ImplicitOutput"]]],
    ["array-holder-late-write.ts", "function run(items: number[]) {\n  const box: number[][] = [];\n  box.push(items);\n  box[0].push(1);\n}\n", [[4,"ImplicitOutput"]]],
    ["object-assign-holder.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  Object.assign(box, { items });\n  box.items.push(1);\n}\n", [[4,"ImplicitOutput"]]],
    ["map-holder-late-write.ts", "function run(items: number[]) {\n  const box = new Map<string, number[]>();\n  box.set(\"key\", items);\n  box.get(\"key\")?.push(1);\n}\n", [[4,"ImplicitOutput"]]],
    ["object-holder-conditional-write.ts", "function run(items: number[], flag: boolean) {\n  const box: { items: number[] } = { items: [] };\n  if (flag) { box.items = items; }\n  box.items.push(1);\n}\n", [[4,"ImplicitOutput"]]],
    ["object-holder-late-helper.ts", "function change(items: number[]) { items.push(1); }\nfunction run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  change(box.items);\n}\n", [[5,"ImplicitOutput"]]],
    ["object-holder-late-closure.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  const later = () => box.items.push(1);\n  later();\n}\n", [[5,"ImplicitOutput"]]],
    ["object-holder-late-private.ts", "function run() {\n  const box: { items: number[] } = { items: [] };\n  box.items = [];\n  box.items.push(1);\n}\n", []],
    ["array-holder-late-private.ts", "function run() {\n  const box: number[][] = [];\n  box.push([]);\n  box[0].push(1);\n}\n", []],
    ["private-insert-no-force.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  box.items = items;\n  return box;\n}\n", []],
    ["holder-alias-insert.ts", "function run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  const alias = box;\n  alias.items = items;\n  box.items.push(1);\n}\n", [[5,"ImplicitOutput"]]],
    ["holder-helper-insert.ts", "function store(box: { items: number[] }, items: number[]) { box.items = items; }\nfunction run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  store(box, items);\n  box.items.push(1);\n}\n", [[5,"ImplicitOutput"]]],
    ["holder-helper-alias-insert.ts", "function identity(box: { items: number[] }) { return box; }\nfunction run(items: number[]) {\n  const box: { items: number[] } = { items: [] };\n  identity(box).items = items;\n  box.items.push(1);\n}\n", [[5,"ImplicitOutput"]]],
    ["holder-conditional-alias-insert.ts", "function run(items: number[], flag: boolean) {\n  const box: { items: number[] } = { items: [] };\n  const other: { items: number[] } = { items: [] };\n  const alias = flag ? box : other;\n  alias.items = items;\n  box.items.push(1);\n}\n", [[6,"ImplicitOutput"]]],
    ["holder-rebound-private.ts", "function run(items: number[]) {\n  let box: { items: number[] } = { items: [] };\n  box.items = items;\n  box = { items: [] };\n  box.items.push(1);\n}\n", []]
  ];
  for (const [name, source, expected] of cases) {
    const actual = ownerRecords(name, source);
    if (expected.length === 0) assert.deepEqual(actual, [], name);
    else for (const finding of expected) assert.ok(actual.some((item) => item[0] === finding[0] && item[1] === finding[1]), name + ": " + JSON.stringify(actual));
  }
});

test("eager replacement and JSON callbacks transfer effects to invocation owners", () => {
  const cases = [
    ["string-literal-replacement.ts", "function run(value: string) {\n  return value.replace(\"a\", \"b\");\n}\n", []],
    ["string-parameter-replacement.ts", "function run(value: string, replacement: string) {\n  return value.replaceAll(\"a\", replacement);\n}\n", []],
    ["json-array-replacer.ts", "function run() {\n  return JSON.stringify({ value: 1 }, [\"value\"]);\n}\n", []],
    ["json-null-replacer.ts", "function run() {\n  return JSON.stringify({ value: 1 }, null);\n}\n", []],
    ["json-undefined-reviver.ts", "function run() {\n  return JSON.parse(\"{\\\"value\\\":1}\", undefined);\n}\n", []],
    ["shadow-undefined-replacement.ts", "function run(value: string) {\n  const undefined = () => { console.log(value); return value; };\n  return value.replace(\"a\", undefined);\n}\n", [[3,"ImplicitOutput"]]],
    ["string-replace-output.ts", "function write(value: string) {\n  console.log(value);\n  return value;\n}\nfunction run(value: string) {\n  return value.replace(\"a\", write);\n}\n", [[6,"ImplicitOutput"]]],
    ["string-replaceall-output.ts", "function write(value: string) {\n  console.log(value);\n  return value;\n}\nfunction run(value: string) {\n  return value.replaceAll(\"a\", write);\n}\n", [[6,"ImplicitOutput"]]],
    ["json-parse-reviver.ts", "function write(key: string, value: unknown) {\n  console.log(key);\n  return value;\n}\nfunction run() {\n  return JSON.parse(\"{\\\"value\\\":1}\", write);\n}\n", [[6,"ImplicitOutput"]]],
    ["json-stringify-replacer.ts", "function write(key: string, value: unknown) {\n  console.log(key);\n  return value;\n}\nfunction run() {\n  return JSON.stringify({ value: 1 }, write);\n}\n", [[6,"ImplicitOutput"]]],
    ["quiet-string-replace.ts", "function replace(value: string) {\n  return value.toUpperCase();\n}\nfunction run(value: string) {\n  return value.replace(\"a\", replace);\n}\n", []],
    ["json-parse-quiet.ts", "function identity(key: string, value: unknown) {\n  return value;\n}\nfunction run() {\n  return JSON.parse(\"{\\\"value\\\":1}\", identity);\n}\n", []],
    ["json-stringify-quiet.ts", "function identity(key: string, value: unknown) {\n  return value;\n}\nfunction run() {\n  return JSON.stringify({ value: 1 }, identity);\n}\n", []]
  ];
  for (const [name, source, expected] of cases) {
    const actual = ownerRecords(name, source);
    if (expected.length === 0) assert.deepEqual(actual, [], name);
    else for (const finding of expected) assert.ok(actual.some((item) => item[0] === finding[0] && item[1] === finding[1]), name + ": " + JSON.stringify(actual));
  }
});

test("eager native iterator consumers force generator summaries", () => {
  const cases = [
    ["generator-promise-all.ts", "function* lines() {\n  yield Date.now();\n}\nfunction run() {\n  return Promise.all(lines());\n}\n", [[5,"ImplicitInput"]]],
    ["generator-promise-all-settled.ts", "function* lines() {\n  yield Date.now();\n}\nfunction run() {\n  return Promise.allSettled(lines());\n}\n", [[5,"ImplicitInput"]]],
    ["promise-race-generator.ts", "function* lines() {\n  yield Date.now();\n}\nfunction run() {\n  return Promise.race(lines());\n}\n", [[5,"ImplicitInput"]]],
    ["generator-object-from-entries.ts", "function* lines(): Generator<[string, number]> {\n  yield [\"key\", Date.now()];\n}\nfunction run() {\n  return Object.fromEntries(lines());\n}\n", [[5,"ImplicitInput"]]],
    ["quiet-promise-all.ts", "function* lines() {\n  yield 1;\n}\nfunction run() {\n  return Promise.all(lines());\n}\n", []],
    ["quiet-object-from-entries.ts", "function* lines(): Generator<[string, number]> {\n  yield [\"key\", 1];\n}\nfunction run() {\n  return Object.fromEntries(lines());\n}\n", []],
    ["generator-create-quiet.ts", "function* lines() {\n  yield Date.now();\n}\nfunction run() {\n  return lines();\n}\n", []]
  ];
  for (const [name, source, expected] of cases) {
    const actual = ownerRecords(name, source);
    if (expected.length === 0) assert.deepEqual(actual, [], name);
    else for (const finding of expected) assert.ok(actual.some((item) => item[0] === finding[0] && item[1] === finding[1]), name + ": " + JSON.stringify(actual));
  }
});

test("storage cells retain selection and execution ownership", () => {
  const cases = [
    ["initial-field-replaced.ts", "function run(items: number[]) {\n  const box = { items };\n  box.items = [];\n  box.items.push(1);\n}\n", []],
    ["initial-field-retained.ts", "function run(items: number[]) {\n  const box = { items };\n  box.items.push(1);\n}\n", [[3, "ImplicitOutput"]]],
    ["initial-element-replaced.ts", "function run(items: number[]) {\n  const box = [items];\n  box[0] = [];\n  box[0].push(1);\n}\n", []],
    ["alias-before-replacement.ts", "function run(items: number[]) {\n  const box = { items };\n  const alias = box.items;\n  box.items = [];\n  alias.push(1);\n}\n", [[5, "ImplicitOutput"]]],
    ["private-sibling-field.ts", "function run(items: number[]) {\n  const box = { items, other: [] as number[] };\n  box.other.push(1);\n}\n", []],
    ["private-sibling-element.ts", "function run(items: number[]) {\n  const box = [items, [] as number[]];\n  box[1].push(1);\n}\n", []],
    ["helper-initial-field-replaced.ts", "function clear(box: {items: number[]}) {\n  box.items = [];\n}\nfunction run(items: number[]) {\n  const box = { items };\n  clear(box);\n  box.items.push(1);\n}\n", []],
    ["helper-late-field-replaced.ts", "function clear(box: {items: number[]}) {\n  box.items = [];\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  box.items = items;\n  clear(box);\n  box.items.push(1);\n}\n", []],
    ["uncalled-rebinding.ts", "function run(items: number[]) {\n  let local: number[] = [];\n  const later = () => { local = items; };\n  local.push(1);\n}\n", []],
    ["false-rebinding.ts", "function run(items: number[]) {\n  let local: number[] = [];\n  if (false) { local = items; }\n  local.push(1);\n}\n", []],
    ["false-callback-rebinding.ts", "function run(items: number[]) {\n  let local: number[] = [];\n  if (false) { (() => { local = items; })(); }\n  local.push(1);\n}\n", []],
    ["helper-callback-insertion.ts", "function each(act: () => void) {\n  act();\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  each(() => { box.items = items; });\n  box.items.push(1);\n}\n", [[7, "ImplicitOutput"]]],
    ["helper-callback-private.ts", "function each(act: () => void) {\n  act();\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  each(() => { box.items = []; });\n  box.items.push(1);\n}\n", []],
    ["nested-helper-factory-identity.ts", "function make() { return { items: [] as number[] }; }\nfunction wrap() { return make(); }\nfunction run(items: number[]) {\n  const first = wrap();\n  const second = wrap();\n  first.items = items;\n  second.items.push(1);\n}\n", []],
    ["nested-helper-factory-effect.ts", "function make() { return { items: [] as number[] }; }\nfunction wrap() { return make(); }\nfunction run(items: number[]) {\n  const first = wrap();\n  first.items = items;\n  first.items.push(1);\n}\n", [[6, "ImplicitOutput"]]],
    ["generator-unforced-insertion.ts", "function run(items: number[]) {\n  const box = { items: [] as number[] };\n  function* later() {\n    box.items = items;\n    yield 1;\n  }\n  later();\n  box.items.push(1);\n}\n", []],
    ["generator-forced-insertion.ts", "function run(items: number[]) {\n  const box = { items: [] as number[] };\n  function* later() {\n    box.items = items;\n    yield 1;\n  }\n  for (const n of later()) {}\n  box.items.push(1);\n}\n", [[8, "ImplicitOutput"]]],
    ["hot-async-insertion.ts", "function run(items: number[]) {\n  const box = { items: [] as number[] };\n  async function now() {\n    box.items = items;\n  }\n  now();\n  box.items.push(1);\n}\n", [[7, "ImplicitOutput"]]],
    ["map-overwrite.ts", "function run(items: number[]) {\n  const box = new Map<string, number[]>();\n  box.set(\"x\", items);\n  box.set(\"x\", []);\n  box.get(\"x\")?.push(1);\n}\n", []],
    ["map-other-entry.ts", "function run(items: number[]) {\n  const box = new Map<string, number[]>();\n  box.set(\"x\", items);\n  box.set(\"y\", []);\n  box.get(\"y\")?.push(1);\n}\n", []],
    ["captured-mutated-through-alias.ts", "function run() {\n  const values: number[] = [];\n  const alias = values;\n  function read() { return values.length; }\n  alias.push(1);\n  return read();\n}\n", []],
    ["module-mutated-alias.ts", "const values: number[] = [];\nconst alias = values;\nfunction change() {\n  alias.push(1);\n}\nfunction run() {\n  return values.length;\n}\n", [[7, "ImplicitInput"]]],
    ["module-unchanged-alias.ts", "const values: number[] = [];\nconst alias = values;\nfunction run() {\n  return values.length;\n}\n", []],
    ["literal-false-while.ts", "function run(items: number[]) {\n  while (false) {\n    items.push(1);\n  }\n}\n", []],
    ["literal-false-for.ts", "function run(items: number[]) {\n  for (; false;) {\n    items.push(1);\n  }\n}\n", []],
    ["helper-callback-two-level.ts", "function each(act: () => void) {\n  act();\n}\nfunction forward(act: () => void) {\n  each(act);\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  forward(() => { box.items = items; });\n  box.items.push(1);\n}\n", [[10, "ImplicitOutput"]]],
    ["helper-callback-deferred.ts", "function each(act: () => void) {\n  return act;\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  each(() => { box.items = items; });\n  box.items.push(1);\n}\n", []],
    ["returned-setter-insertion.ts", "function make(box: {items: number[]}, items: number[]) {\n  return () => { box.items = items; };\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  const set = make(box, items);\n  set();\n  box.items.push(1);\n}\n", [[8, "ImplicitOutput"]]],
    ["returned-setter-private.ts", "function make(box: {items: number[]}, items: number[]) {\n  return () => { box.items = items; };\n}\nfunction run(items: number[]) {\n  const box = { items: [] as number[] };\n  const set = make(box, []);\n  set();\n  box.items.push(1);\n}\n", []],
    ["called-rebinding.ts", "function run(items: number[]) {\n let local: number[] = [];\n const now = () => { local = items; };\n now();\n local.push(1);\n}", [[5, "ImplicitOutput"]]],
    ["called-private-rebinding.ts", "function run(items: number[]) {\n let local = items;\n const now = () => { local = []; };\n now();\n local.push(1);\n}", []],
    ["callback-argument-cell.ts", "function each(box: {items:number[]}, value:number[], f:(b:{items:number[]},v:number[])=>void) {\n f(box,value);\n}\nfunction run(items:number[]) {\n const box={items:[] as number[]};\n each(box,items,(b,v)=>{b.items=v;});\n box.items.push(1);\n}", [[7, "ImplicitOutput"]]],
    ["callback-argument-private.ts", "function each(box: {items:number[]}, value:number[], f:(b:{items:number[]},v:number[])=>void) {\n f(box,value);\n}\nfunction run(items:number[]) {\n const box={items};\n each(box,[],(b,v)=>{b.items=v;});\n box.items.push(1);\n}", []],
    ["initial-map-replaced.ts", "function run(items:number[]) {\n const box=new Map<string,number[]>([[\"a\",items]]);\n box.set(\"a\",[]);\n box.get(\"a\")?.push(1);\n}", []],
    ["map-initial-sibling.ts", "function run(items:number[]) {\n const box=new Map<string,number[]>([[\"a\",items],[\"b\",[]]]);\n box.get(\"b\")?.push(1);\n}", []],
    ["private-nested-property.ts", "function run(items:{n:number}) {\n const box={items,own:{n:0}};\n box.own.n++;\n}", []],
    ["helper-private-property.ts", "function mutate(box:{items:{n:number},own:{n:number}}) {\n box.own.n++;\n}\nfunction run(items:{n:number}) {\n mutate({items,own:{n:0}});\n}", []],
    ["private-copy-sibling.ts", "function run(items:number[]) {\n const box=[items,[]];\n const copy=box.slice();\n copy[1].push(1);\n}", []],
    ["private-spread-sibling.ts", "function run(items:number[]) {\n const box=[items,[]];\n const copy=[...box];\n copy[1].push(1);\n}", []],
  ];
  for (const [name, source, expected] of cases) {
    const actual = ownerRecords(name, source);
    if (expected.length === 0) assert.deepEqual(actual, [], name);
    else for (const finding of expected) assert.ok(actual.some((item) => item[0] === finding[0] && item[1] === finding[1]), name + ": " + JSON.stringify(actual));
  }
});

test("cell replacement follows literal and conditional execution", () => {
  const cases = [
    ["false-while-rebinding.ts", "function run(items: number[]) {\n let local:number[]=[];\n while(false) {local=items;}\n local.push(1);\n}", []],
    ["false-for-rebinding.ts", "function run(items: number[]) {\n let local:number[]=[];\n for(;false;) {local=items;}\n local.push(1);\n}", []],
    ["false-if-rebinding.ts", "function run(items: number[]) {\n let local:number[]=[];\n if(false) {local=items;}\n local.push(1);\n}", []],
    ["true-if-replacement.ts", "function run(items: number[]) {\n let local=items;\n if(true) {local=[];}\n local.push(1);\n}", []],
    ["nested-cell-replacement.ts", "function run(items: number[]) {\n const box={inner:{items}};\n box.inner.items=[];\n box.inner.items.push(1);\n}", []],
    ["spread-property-replacement.ts", "function run(items: number[]) {\n const initial={items};\n const box={...initial,items:[] as number[]};\n box.items.push(1);\n}", []],
    ["conditional-callback-replacement.ts", "function each(f:()=>void,flag:boolean) {\n if(flag) f();\n}\nfunction run(items:number[],flag:boolean) {\n const box={items};\n each(()=>{box.items=[];},flag);\n box.items.push(1);\n}", [[7, "ImplicitOutput"]]],
    ["parameter-helper-shared-cell.ts", "function change(box:{inner:{n:number}}) {\n box.inner.n++;\n}\nfunction run(items:{n:number}) {\n change({inner:items});\n}", [[5, "ImplicitOutput"]]],
  ];
  for (const [name, source, expected] of cases) {
    assert.deepEqual(ownerRecords(name, source), expected, name);
  }
});

test("helpers preserve selected parameter cells", () => {
  const select = "function change(box:{a:number[],b:number[]}) { const selected=box.b; selected.push(1); }\n";
  assert.deepEqual(ownerRecords("selected-shared.ts", select + "function run(items:number[]) { change({a:[],b:items}); }"), [[2, "ImplicitOutput"]]);
  assert.deepEqual(ownerRecords("selected-private.ts", select + "function run(items:number[]) { change({a:items,b:[]}); }"), []);
  const returned = "function select(box:{a:number[],b:number[]}) { return box.b; }\n";
  assert.deepEqual(ownerRecords("returned-shared.ts", returned + "function run(items:number[]) { select({a:[],b:items}).push(1); }"), [[2, "ImplicitOutput"]]);
  assert.deepEqual(ownerRecords("returned-private.ts", returned + "function run(items:number[]) { select({a:items,b:[]}).push(1); }"), []);
});
