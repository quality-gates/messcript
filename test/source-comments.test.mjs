import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { sourceComments } from "../dist/ast/source-comments.js";

function sourceFile(text, fileName = "comments.ts") {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".js")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
}

test("sourceComments finds comments in template interpolations and after templates", () => {
  const file = sourceFile([
    "const value = `prefix ${(() => {",
    "  // TODO interpolation { braces }",
    "  return { value: \"}\" };",
    "})()} suffix`;",
    "// FIXME after template",
  ].join("\n"));

  assert.deepEqual(sourceComments(file).map((comment) => comment.text), [
    "// TODO interpolation { braces }",
    "// FIXME after template",
  ]);
});

test("sourceComments finds comments after regex literals with braces and slash-equals", () => {
  const file = sourceFile([
    "const regex = /[{}]/;",
    "// TODO after regex",
    "const slashEqualsRegex = /=foo{/;",
    "// FIXME after slash-equals regex",
  ].join("\n"));

  assert.deepEqual(sourceComments(file).map((comment) => comment.text), [
    "// TODO after regex",
    "// FIXME after slash-equals regex",
  ]);
});

test("sourceComments excludes JSX text with backticks, apostrophes, and comment-like text", () => {
  const file = sourceFile("const label = <p>Press ` and don't show // TODO</p>;", "comments.tsx");

  assert.deepEqual(sourceComments(file), []);
});

test("sourceComments filters comment-like text at the start of each JSX text node", () => {
  const file = sourceFile([
    "const first = <p>// TODO</p>;",
    "const second = <p>// FIXME</p>;",
  ].join("\n"), "comments.tsx");

  assert.deepEqual(sourceComments(file), []);
});

test("sourceComments keeps real comments before and after JSX text", () => {
  const file = sourceFile([
    "// TODO before JSX",
    "const label = <p>visible text</p>;",
    "// FIXME after JSX",
  ].join("\n"), "comments.tsx");

  assert.deepEqual(sourceComments(file).map((comment) => comment.text), [
    "// TODO before JSX",
    "// FIXME after JSX",
  ]);
});

test("sourceComments includes comments in JSX expression containers", () => {
  const file = sourceFile("const view = <div>{/* TODO */}</div>;", "comments.tsx");

  assert.deepEqual(sourceComments(file).map((comment) => comment.text), ["/* TODO */"]);
  assert.equal(sourceComments(file)[0].kind, ts.SyntaxKind.MultiLineCommentTrivia);
});

test("sourceComments ignores directive-looking string literals", () => {
  const file = sourceFile('const directive = "// messcript-disable-next-line ShortVariable";');

  assert.deepEqual(sourceComments(file), []);
});

test("sourceComments returns the same comments for identical JavaScript and TSX text", () => {
  const text = 'const label = "<p>// TODO</p>"; // TODO outside';
  const javascript = sourceComments(sourceFile(text, "comments.js"));
  const tsx = sourceComments(sourceFile(text, "comments.tsx"));

  assert.deepEqual(tsx, javascript);
  assert.deepEqual(tsx.map((comment) => comment.text), ["// TODO outside"]);
});

test("sourceComments keeps nested comments before trailing comments in source order", () => {
  const file = sourceFile([
    "function work() {",
    "  // TODO inside",
    "} // FIXME after declaration",
  ].join("\n"));

  assert.deepEqual(sourceComments(file).map((comment) => comment.text), [
    "// TODO inside",
    "// FIXME after declaration",
  ]);
});

test("sourceComments sorts, de-duplicates, and caches each parsed file's comments", () => {
  const file = sourceFile([
    "// before",
    "const value = 1; // trailing",
    "/* after */",
  ].join("\n"));
  const comments = sourceComments(file);
  const positions = comments.map((comment) => comment.pos);

  assert.deepEqual(comments.map((comment) => comment.text), ["// before", "// trailing", "/* after */"]);
  assert.deepEqual(positions, [...new Set(positions)].sort((left, right) => left - right));
  assert.strictEqual(sourceComments(file), comments);
});
