import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./explicitness-support.mjs";

test("appending to an owned array preserves captured existing slots", () => {
  assert.deepEqual(messages("owned-push.ts", `function fresh(): number[] { return [3]; }
function outer() {
  const values = fresh();
  const head = () => values[0];
  values.push(4);
  return head();
}
`), []);
});

for (const [name, read, mutation] of [
  ["unshift", "values[0]", "values.unshift(4)"],
  ["splice", "values[0]", "values.splice(0, 1, 4)"],
  ["sort", "values[0]", "values.sort()"],
  ["index", "values[0]", "values[0] = 4"],
  ["length", "values.length", "values.push(4)"],
  ["negative-at", "values.at(-1)", "values.push(4)"],
  ["appended-slot", "values[1]", "values.push(4)"],
]) {
  test(`owned array ${name} still affects captured reads`, () => {
    assert.deepEqual(messages(`${name}.ts`, `function fresh(): number[] { return [3]; }
function outer() {
  const values = fresh();
  const head = () => ${read};
  ${mutation};
  return head();
}
`), ["4:ImplicitInput: The arrow function head() reads values, an implicit input."]);
  });
}

for (const factory of ["const fresh = () => ([3]);", "const fresh = function () { return [3]; };"]) {
  test(`a literal returned by a bound factory retains its existing slots: ${factory}`, () => {
    assert.deepEqual(messages("bound-factory.ts", `${factory}
function outer() {
  const values = fresh();
  const head = () => values[0];
  values.push(4);
  return head();
}
`), []);
  });
}

for (const factory of [
  "function fresh() { const values = [3]; values.pop(); return values; }",
  "function literal() { return [3]; } function fresh() { const values = literal(); values.pop(); return values; }",
  "const fresh = () => { const values = [3]; values.pop(); return values; };",
  "const literal = () => [3]; const fresh = () => { const values = literal(); values.pop(); return values; };",
]) {
  test(`factory length changes stay conservative: ${factory}`, () => {
    const findings = messages("changed-factory.ts", `${factory}
function outer() {
  const values = fresh();
  const head = () => values[0];
  values.push(4);
  return head();
}
`);
    assert.ok(findings.includes("4:ImplicitInput: The arrow function head() reads values, an implicit input."), findings.join("\n"));
  });
}

for (const collection of ["new Set([store])", "new Map([[0, store]])"]) {
  test(`${collection} forEach transfers callback writes to its caller`, () => {
    const findings = messages("collection-callback.ts", `const store: number[] = [];
function outer() {
  const items = ${collection};
  items.forEach((item) => { item.push(1); });
  return 0;
}
`);
    assert.ok(findings.some((finding) => /^4:(ImplicitOutput|UnknownEffect): The function outer\(\)/.test(finding)), findings.join("\n"));
    assert.ok(findings.some((finding) => /^4:ImplicitOutput: The arrow function anonymous\(\)/.test(finding)), findings.join("\n"));
  });
}
