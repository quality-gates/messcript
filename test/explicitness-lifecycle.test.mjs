import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

test("closure invocation and capture instances", async (t) => {
  for (const [name, source, expected] of [
    [
      "r14-wrapper-invoke-A.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function make() { return inner([shared]); }
function wrap() { return make(); }
function outer() { const g = wrap(); return g(); }
`,
      ["6:ImplicitInput"],
    ],
    [
      "r14-stored-invoke-A.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function outer() { const box = { f: inner([shared]) }; return box.f(); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-helper-invoke-A.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function invoke(fn: () => number) { return fn(); }
function outer() { return invoke(inner([shared])); }
`,
      ["5:ImplicitInput"],
    ],
    [
      "r14-wrapper-invoke-C.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function make() { return inner([[1]]); }
function wrap() { return make(); }
function outer() { const g = wrap(); return g(); }
`,
      [],
    ],
    [
      "r14-stored-invoke-C.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function outer() { const box = { f: inner([[1]]) }; return box.f(); }
`,
      [],
    ],
    [
      "r14-helper-invoke-C.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function invoke(fn: () => number) { return fn(); }
function outer() { return invoke(inner([[1]])); }
`,
      [],
    ],
    [
      "r14-return-quiet.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function outer() { return inner([shared]); }
`,
      [],
    ],
    [
      "r14-stored-quiet.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function outer() { return { f: inner([shared]) }; }
`,
      [],
    ],
    [
      "r14-instances-private.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function outer() { const a = inner([[1]]); const b = inner([shared]); return a(); }
`,
      [],
    ],
    [
      "r14-instances-shared.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function inner(a: number[][]) { return () => a[0][0]; }
function outer() { const a = inner([shared]); const b = inner([[1]]); return a(); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-mutable-to-shared.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function outer() { let a = [1]; const f = () => a[0]; a = shared; return f(); }
`,
      ["3:ImplicitInput"],
    ],
    [
      "r14-mutable-to-private.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function outer() { let a = shared; const f = () => a[0]; a = [1]; return f(); }
`,
      [],
    ],
    [
      "r14-escaped-cell-A.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell = a; const read = () => cell[0]; const set = (next: number[]) => { cell = next; }; return { read, set }; }
function outer() { const box = make([1]); box.set(shared); return box.read(); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-escaped-cell-C.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell = a; const read = () => cell[0]; const set = (next: number[]) => { cell = next; }; return { read, set }; }
function outer() { const box = make([1]); box.set([1]); return box.read(); }
`,
      [],
    ],
  ]) {
    await t.test(name, () => {
      const found = messages(name, source)
        .filter((message) => message.includes("The function outer() "))
        .map((message) => message.split(": ", 1)[0]);
      assert.deepEqual(found, expected);
    });
  }
});

test("closure writes follow evaluation order", async (t) => {
  for (const [name, source, expected] of [
    [
      "r14-order-helper-shared.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make([1]); function use(next:number[]) { box.set(next); return box.read(); } use([1]); return use(shared); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-order-helper-private.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make(shared); function use(next:number[]) { box.set(next); return box.read(); } return use([1]); }
`,
      [],
    ],
    [
      "r14-order-argument-shared.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make([1]); function read(_x:void) { return box.read(); } return read(box.set(shared)); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-order-argument-private.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make(shared); function read(_x:void) { return box.read(); } return read(box.set([1])); }
`,
      [],
    ],
    [
      "r14-order-two-instance.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make([1]); const other=make(shared); other.set(shared); return box.read(); }
`,
      [],
    ],
    [
      "r14-order-wrapper-shared.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { function wrap(a:number[]) { return {box:make(a)}; } const a=wrap([1]); a.box.set(shared); return a.box.read(); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-order-before-after.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make([1]); const before=box.read(); box.set(shared); return before+box.read(); }
`,
      ["4:ImplicitInput"],
    ],
    [
      "r14-order-reverse-order.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) { let cell=a; const read=()=>cell[0]; const set=(next:number[])=>{cell=next;}; return {read,set}; }
function outer() { const box=make([1]); function read() {return box.read();} function set() {box.set(shared);} set(); return read(); }
`,
      ["4:ImplicitInput"],
    ],
  ]) {
    await t.test(name, () => {
      const found = messages(name, source)
        .filter((message) => message.includes("The function outer() "))
        .map((message) => message.split(": ", 1)[0]);
      assert.deepEqual(found, expected);
    });
  }
});

test("branches and zero-trip loops retain captured alternatives", async (t) => {
  for (const [name, source, expected] of [
    [
      "r14-branch-shared-first.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) {
  let cell = a;
  return { read: () => cell[0], set: (next: number[]) => { cell = next; } };
}
function outer(flag: boolean) {
  const box = make([1]);
  if (flag) box.set(shared); else box.set([1]);
  return box.read();
}
`,
      ["10:ImplicitInput"],
    ],
    [
      "r14-branch-shared-last.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) {
  let cell = a;
  return { read: () => cell[0], set: (next: number[]) => { cell = next; } };
}
function outer(flag: boolean) {
  const box = make([1]);
  if (flag) box.set([1]); else box.set(shared);
  return box.read();
}
`,
      ["10:ImplicitInput"],
    ],
    [
      "r14-branch-private.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) {
  let cell = a;
  return { read: () => cell[0], set: (next: number[]) => { cell = next; } };
}
function outer(flag: boolean) {
  const box = make([1]);
  if (flag) box.set([2]); else box.set([1]);
  return box.read();
}
`,
      [],
    ],
    [
      "r14-loop-zero-shared.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) {
  let cell = a;
  return { read: () => cell[0], set: (next: number[]) => { cell = next; } };
}
function outer(count: number) {
  const box = make(shared);
  for (let i = 0; i < count; i++) box.set([1]);
  return box.read();
}
`,
      ["10:ImplicitInput"],
    ],
    [
      "r14-loop-zero-private.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) {
  let cell = a;
  return { read: () => cell[0], set: (next: number[]) => { cell = next; } };
}
function outer(count: number) {
  const box = make([1]);
  for (let i = 0; i < count; i++) box.set([1]);
  return box.read();
}
`,
      [],
    ],
    [
      "r14-branch-helper.ts",
      `const shared: number[] = [1];
function bump() { shared[0] = 2; }
function make(a: number[]) {
  let cell = a;
  return { read: () => cell[0], set: (next: number[]) => { cell = next; } };
}
function outer(flag: boolean) {
  const box = make([1]);
  function run() { if (flag) box.set(shared); else box.set([1]); } run();
  return box.read();
}
`,
      ["10:ImplicitInput"],
    ],
  ]) {
    await t.test(name, () => {
      const found = messages(name, source)
        .filter((message) => message.includes("The function outer() "))
        .map((message) => message.split(": ", 1)[0]);
      assert.deepEqual(found, expected);
    });
  }
});
