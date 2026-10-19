import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { visitExecutableRegions, walkExecutableRegion } from "../dist/ast/executable-regions.js";
import { findElseExpression } from "../dist/rules/else-expression.js";
import { findIfStatementAssignment } from "../dist/rules/if-statement-assignment.js";

function sourceFile(source) {
  return ts.createSourceFile("regions.ts", source, ts.ScriptTarget.Latest, true);
}

test("executable regions visit the module before function bodies with bounded ownership", () => {
  const file = sourceFile(`
function outer(value = ignored(), callback = () => defaultBody()) {
  before();
  function inner() { nested(); }
  class Local { static { localStatic(); } method() { methodBody(); } }
  after();
}
moduleCall();
class Top { static { moduleStatic(); } }
const arrow = () => arrowBody();
`);
  const calls = [];
  const roots = [];
  visitExecutableRegions(file, (node, owner) => {
    if (node === file || node === owner.body) roots.push(owner);
    if (ts.isCallExpression(node)) {
      calls.push([node.getText(file), owner === file ? "module" : owner.getText(file).split("{")[0].trim()]);
    }
    assert.ok(!ts.isFunctionLike(node));
  });
  assert.deepEqual(calls, [
    ["moduleCall()", "module"],
    ["moduleStatic()", "module"],
    ["before()", "function outer(value = ignored(), callback = () => defaultBody())"],
    ["localStatic()", "function outer(value = ignored(), callback = () => defaultBody())"],
    ["after()", "function outer(value = ignored(), callback = () => defaultBody())"],
    ["defaultBody()", "() => defaultBody()"],
    ["nested()", "function inner()"],
    ["methodBody()", "method()"],
    ["arrowBody()", "() => arrowBody()"],
  ]);
  assert.equal(roots.length, 6);
  assert.equal(roots[0], file);
});

test("bounded inspection includes its root but excludes nested function nodes and bodies", () => {
  const file = sourceFile(`if ((value = (() => { hidden = 1; return true; })())) {}`);
  const condition = file.statements[0].expression;
  const visited = [];
  walkExecutableRegion(condition, (node) => visited.push(node));
  assert.equal(visited[0], condition);
  assert.deepEqual(visited.filter(ts.isBinaryExpression).map((node) => node.getText(file)), [
    "value = (() => { hidden = 1; return true; })()",
  ]);
  assert.ok(!visited.some(ts.isFunctionLike));
  const arrow = sourceFile("() => hidden = 1;").statements[0].expression;
  const functionNodes = [];
  walkExecutableRegion(arrow, (node) => functionNodes.push(node));
  assert.deepEqual(functionNodes, []);
});

test("both rules preserve region order, locations and nested-condition ownership", () => {
  const file = sourceFile(`function outer(value = (ignored = 1)) {
  if ((value = (() => {
    hidden = 1;
    if (inner = next()) {} else {}
    return true;
  })())) {} else {}
}
if (moduleValue = next()) {} else {}
class Top { static { if (staticValue = next()) {} else {} } }
`);
  const project = (findings) => findings.map(({ line, column, context }) => ({ line, column, context }));
  assert.deepEqual(project(findIfStatementAssignment(file)), [
    { line: 8, column: 5, context: "module" },
    { line: 9, column: 26, context: "module" },
    { line: 2, column: 8, context: "function outer()" },
    { line: 4, column: 9, context: "arrow function anonymous()" },
  ]);
  assert.deepEqual(project(findElseExpression(file)), [
    { line: 8, column: 35, context: "module" },
    { line: 9, column: 56, context: "module" },
    { line: 6, column: 18, context: "function outer()" },
    { line: 4, column: 33, context: "arrow function anonymous()" },
  ]);
});
