import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

const ownedBy = (owner, name, source) => messages(name, source).filter(message => message.includes(`${owner}()`));

const cases = [
  {
    name: "heritage-call",
    owner: "outer",
    source: (effect) => `const log: number[] = [];
class Base {}
function mix(b: typeof Base) {
  ${effect}
  return class extends b {};
}
function outer() {
  class Y extends mix(Base) {}
  return 1;
}
`,
    effectful: [
      "4:ImplicitOutput: The function mix() writes log, an implicit output.",
      "5:UnknownEffect: The constructor constructs unresolved base class, an unknown effect.",
      "8:ImplicitOutput: The function outer() writes log, an implicit output.",
      "8:UnknownEffect: The constructor constructs unresolved base class, an unknown effect.",
    ],
  },
  {
    name: "heritage-comma",
    owner: "outer",
    source: (effect) => `const log: number[] = [];
class Base {}
function outer() {
  class Y extends (${effect ? "log.push(1)" : "0"}, Base) {}
  return 1;
}
`,
    effectful: [
      "4:UnknownEffect: The constructor constructs unresolved base class, an unknown effect.",
      "4:ImplicitOutput: The function outer() writes log, an implicit output.",
    ],
  },
  {
    name: "instantiation-expression",
    owner: "outer",
    source: (effect) => `const log: number[] = [];
function make() {
  ${effect}
  return <T,>(x: T) => x;
}
function outer() {
  const id = make()<number>;
  return typeof id === "function" ? 1 : 0;
}
`,
    effectful: [
      "3:ImplicitOutput: The function make() writes log, an implicit output.",
      "7:ImplicitOutput: The function outer() writes log, an implicit output.",
    ],
  },
  {
    name: "user-push-on-array-element",
    owner: "outer",
    source: (effect) => `const log: number[] = [];
function outer() {
  const sinks = [{ push: (x: number) => { ${effect.replace("1", "x")} } }];
  sinks[0].push(1);
  return 1;
}
`,
    effectful: [
      "3:ImplicitOutput: The arrow function anonymous() writes log, an implicit output.",
      "4:ImplicitOutput: The function outer() writes log, an implicit output.",
    ],
  },
  {
    name: "user-method-argument",
    owner: "caller",
    source: (effect) => `const log: number[] = [];
function outer(sink: { write(x: number): void }) {
  sink.write(1);
  return 1;
}
function caller() {
  return outer({ write: (x: number) => { ${effect.replace("1", "x")} } });
}
`,
    effectful: [
      "3:ImplicitOutput: The function outer() mutates argument sink, an implicit output.",
      "7:ImplicitOutput: The function caller() writes log, an implicit output.",
      "7:ImplicitOutput: The arrow function anonymous() writes log, an implicit output.",
    ],
  },
  {
    name: "constructor-replacement",
    owner: "outer",
    source: (effect) => `const log: number[] = [];
class Counter {
  constructor() {
    return { tick: () => { ${effect} return 1; } };
  }
  tick() { return 0; }
}
function outer() {
  return new Counter().tick();
}
`,
    effectful: [
      "4:ImplicitOutput: The arrow function anonymous() writes log, an implicit output.",
      "9:ImplicitOutput: The function outer() writes log, an implicit output.",
    ],
  },
];

for (const { name, owner, source, effectful } of cases) {
  test(`${name} effects reach the evaluating ${owner}()`, () => {
    assert.deepEqual(messages(`${name}.ts`, source("log.push(1);")), effectful);
  });

  test(`${name} with a pure callee gives ${owner}() no finding`, () => {
    assert.deepEqual(ownedBy(owner, `${name}-pure.ts`, source("")), []);
  });
}

const decorated = [
  {
    name: "class-decorator",
    source: (effect) => `const log: number[] = [];
function tag(value: unknown, context: ClassDecoratorContext) {
  ${effect}
  return undefined;
}
function outer() {
  @tag
  class Box {}
  return 1;
}
`,
    tagLine: 3,
    outerLine: 7,
  },
  {
    name: "method-decorator",
    source: (effect) => `const log: number[] = [];
function mark(value: unknown, context: ClassMethodDecoratorContext) {
  ${effect}
  return undefined;
}
function outer() {
  class Box {
    @mark
    run() { return 1; }
  }
  return new Box().run();
}
`,
    tagLine: 3,
    outerLine: 8,
  },
];

for (const { name, source, tagLine, outerLine } of decorated) {
  test(`${name} effects reach the evaluating outer() as an unknown effect`, () => {
    const found = messages(`${name}.ts`, source("log.push(1);"));
    assert.ok(found.some(message => message.startsWith(`${tagLine}:ImplicitOutput:`)), JSON.stringify(found));
    assert.deepEqual(found.filter(message => message.includes("outer()")), [
      `${outerLine}:UnknownEffect: The function outer() uses unresolved decorator application, an unknown effect.`,
    ]);
  });
}
