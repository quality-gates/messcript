import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { locate } from "../dist/location.js";
import { analyze } from "../dist/analyzer.js";

// TypeScript's scanner treats U+2028 (LINE SEPARATOR) and U+2029
// (PARAGRAPH SEPARATOR) as line terminators per the ECMAScript spec, but
// git, GitHub, GitLab, and every editor only recognise \n/\r\n. Using
// `sourceFile.getLineAndCharacterOfPosition` straight from the TS API
// therefore reports line numbers that disagree with what every other
// tool calls "line N" whenever a file contains one of these characters.

test("locate() ignores U+2028 LINE SEPARATOR as a line terminator", () => {
  const source = `${String.fromCodePoint(0x2028)}function f() {}`;
  const sourceFile = ts.createSourceFile("unicode-fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const position = locate(sourceFile, source.indexOf("function"));
  assert.equal(position.line, 0, "U+2028 must not be treated as a line break by locate()");
});

test("locate() ignores U+2029 PARAGRAPH SEPARATOR as a line terminator", () => {
  const source = `${String.fromCodePoint(0x2029)}function f() {}`;
  const sourceFile = ts.createSourceFile("unicode-fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const position = locate(sourceFile, source.indexOf("function"));
  assert.equal(position.line, 0, "U+2029 must not be treated as a line break by locate()");
});

test("locate() still treats \\n and \\r\\n as line terminators", () => {
  const source = "const a = 1;\nconst b = 2;\r\nconst c = 3;";
  const sourceFile = ts.createSourceFile("newline-fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(locate(sourceFile, source.indexOf("const b")).line, 1);
  assert.equal(locate(sourceFile, source.indexOf("const c")).line, 2);
});

test("analyze() never reports a finding beyond a file's physical (\\n-counted) line count", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "messcript-unicode-"));
  try {
    const file = join(workspaceRoot, "repro.ts");
    const source = `${String.fromCodePoint(0x2028)}function f() {}`;
    const physicalLineCount = source.split(/\r\n|\r|\n/).length;
    writeFileSync(file, source, "utf8");

    const { findings } = analyze([file], ["typescript"], {});
    const outOfRange = findings.filter((finding) => finding.line > physicalLineCount);

    assert.deepEqual(outOfRange, [], `expected no findings beyond line ${physicalLineCount}, got: ${JSON.stringify(outOfRange)}`);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
