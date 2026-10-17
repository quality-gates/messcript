import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

const unknown = (owner, source, description) => {
  const found = messages("decorator-runtime.ts", source).filter(message => message.includes(`${owner}()`) && message.includes("UnknownEffect"));
  assert.ok(found.some(message => message.includes(description)), JSON.stringify(found));
};

for (const [name, setup, invoke] of [
  ["direct", "", "local.go()"],
  ["alias", "const alias = local;", "alias.go()"],
  ["extracted", "const go = local.go;", "go()"],
  ["destructured", "const { go } = local;", "go()"],
  ["bound", "const go = local.go.bind(local);", "go()"],
  ["returned", "function expose() { return local; }", "expose().go()"],
]) {
  test(`decorated member ${name} calls retain replacement uncertainty`, () => {
    unknown("run", `declare function mark(...args: unknown[]): any;
class Local { @mark go() { return 1; } }
const local = new Local();
${setup}
function run() { ${invoke}; }
`, "calls ");
  });
}

test("decorated construction does not certify the original constructor", () => {
  unknown("run", `declare function mark(...args: unknown[]): any;
@mark class Local { value = 1; }
function run() { return new Local(); }
`, "constructs unresolved class");
});

for (const [name, member, action] of [
  ["instance sibling", "@mark go() {} sibling() { return 1; }", "local.sibling()"],
  ["getter", "@mark go() {} value = 1;", "local.value"],
  ["setter", "@mark go() {} value = 1;", "local.value = 2"],
  ["static sibling", "@mark static go() {} static sibling() { return 1; }", "Local.sibling()"],
  ["static getter", "@mark static go() {} static value = 1;", "Local.value"],
]) {
  test(`decorator initializers can change an undecorated ${name}`, () => {
    unknown("run", `declare function mark(...args: unknown[]): any;
class Local { ${member} }
const local = new Local();
function run() { return ${action}; }
`, name.includes("sibling") ? "calls " : "accesses unresolved accessor");
  });
}

for (const [name, action] of [["this", "this.go()"], ["super", "super.go()"]]) {
  test(`decorated base uncertainty survives ${name} dispatch`, () => {
    unknown("run", `declare function mark(...args: unknown[]): any;
class Base { @mark go() { return 1; } }
class Child extends Base { run() { return ${action}; } }
`, "calls ");
  });
}

test("constructor parameter decorators can replace runtime members", () => {
  unknown("run", `declare function mark(...args: unknown[]): any;
class Local { constructor(@mark value: number) {} go() { return 1; } }
const local = new Local(1);
function run() { return local.go(); }
`, "calls ");
});

test("unrelated nested decorators do not invalidate an outer class", () => {
  const source = `declare function mark(...args: unknown[]): any;
class Local {
  unrelated() { @mark class Nested {} return Nested; }
  go() { return 1; }
}
function run() { return new Local().go(); }
`;
  assert.deepEqual(messages("nested-decorator-control.ts", source).filter(message => message.includes("run()")), []);
});

test("undecorated construction and members remain resolved", () => {
  const source = `class Local { value = 1; go() { return this.value; } }
function run() { const local = new Local(); return local.go(); }
`;
  assert.deepEqual(messages("undecorated-control.ts", source).filter(message => message.includes("run()")), []);
});

test("mixed decorated and unresolved aliases retain introduced accessor uncertainty", () => {
  unknown("run", `declare const choose: boolean;
declare const other: object;
declare function mark(...args: unknown[]): any;
class Local { @mark go() {} value = 1; }
const local = choose ? new Local() : other;
function run() { return local.value; }
`, "accesses unresolved accessor");
});

for (const [name, members, setup, action] of [
  ["parameter accessor", "value = 1;", "", "if (choose) x = new A(); return x.value;"],
  ["parameter call", "go() { return 1; }", "", "if (choose) x = new A(); return x.go();"],
  ["conditional alias call", "go() { return 1; }", "const local = choose ? new A() : other;", "return local.go();"],
  ["decorated parameter call", "@mark go() { return 1; }", "", "if (choose) x = new A(); return x.go();"],
]) {
  test(`partly known ${name} keeps every same-named member`, () => {
    const member = name.includes("accessor") ? "get value() { counter++; return 1; }" : "go() { counter++; return 1; }";
    const found = messages("partly-known.ts", `declare const choose: boolean;
declare const other: object;
let counter = 0;
declare function mark(...args: unknown[]): any;
class A { ${members} }
class B { ${member} }
${setup}
function run(x: any) { ${action} }
`).filter(message => message.includes("run()"));
    assert.ok(found.some(message => message.includes("ImplicitOutput") && message.includes("writes counter")), JSON.stringify(found));
    assert.ok(found.some(message => message.includes("UnknownEffect")), JSON.stringify(found));
  });
}

test("a known decorator that ignores its arguments and returns nothing keeps members resolved", () => {
  assert.deepEqual(messages("inert-decorator.ts", `const log: number[] = [];
function mark(value: unknown, context: ClassMethodDecoratorContext) {
  log.push(1);
  return undefined;
}
function outer() {
  class Box {
    @mark
    run() { return 1; }
  }
  return new Box().run();
}
`).filter(message => message.includes("outer()")), [
    "8:UnknownEffect: The function outer() uses unresolved decorator application, an unknown effect.",
  ]);
});

for (const [name, body, extra = ""] of [
  ["returns a replacement", "return () => { log.push(1); return 2; };"],
  ["reads its arguments", "(value as any).patched = true;"],
  ["reads arguments", "void arguments;"],
  ["reads arguments in a parameter default", "", ", seen = arguments[0]"],
  ["calls eval", "eval(\"value.patched = true\");"],
]) {
  test(`a known decorator that ${name} keeps replacement uncertainty`, () => {
    unknown("outer", `const log: number[] = [];
function mark(value: unknown, context: ClassMethodDecoratorContext${extra}): any {
  ${body}
}
function outer() {
  class Box {
    @mark
    run() { return 1; }
  }
  return new Box().run();
}
`, "calls ");
  });
}
