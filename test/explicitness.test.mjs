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

test("class state is not reported by default", () => {
  assert.deepEqual(messages("class-default.js", classSource), []);
});

test("include-this reports class state reads and writes, but not method calls or constructors", () => {
  assert.deepEqual(messages("class-strict.js", classSource, strictRuleset), [
    "3:ImplicitInput: The method increment() reads this.count, an implicit input.",
    "3:ImplicitOutput: The method increment() writes this.count, an implicit output.",
    "4:ImplicitInput: The method format() reads this.count, an implicit input.",
    "5:ImplicitInput: The method self() reads this, an implicit input.",
  ]);
  assert.deepEqual(messages("class-after-strict.js", classSource), []);
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


