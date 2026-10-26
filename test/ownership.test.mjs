import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { analyzeScopes } from "../dist/ast/scopes.js";
import { expressionStorageFact } from "../dist/analysis/ownership.js";

const SOURCE = `class Local {}
function make() {
  return new Local();
}`;

// Gives the storage of `new Local()` inside make(), resolved through the given resolver.
function constructionFact(resolver) {
  const file = ts.createSourceFile("ownership.ts", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const owner = file.statements[1];
  const construction = owner.body.statements[0].expression;
  return expressionStorageFact(analyzeScopes(file), construction, owner, construction, resolver);
}

function resolver(certainClass) {
  return { call: () => undefined, certainClass, insertions: () => [] };
}

test("a local class constructs a fresh private allocation when the resolver confirms the class identity", () => {
  const checked = [];
  const fact = constructionFact(resolver((callee) => {
    checked.push(callee.getText());
    return true;
  }));
  assert.deepEqual(checked, ["Local"]);
  assert.equal(fact.outer.length, 1);
  assert.match(fact.outer[0], /^private:\d+$/);
});

test("a local class constructs unknown storage when the resolver cannot confirm the class identity", () => {
  assert.deepEqual(constructionFact(resolver(() => false)).outer, ["unknown"]);
});

test("a local class constructs unknown storage without a resolver to confirm the class identity", () => {
  assert.deepEqual(constructionFact(undefined).outer, ["unknown"]);
});
