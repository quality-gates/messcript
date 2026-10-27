import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import ts from "typescript";
import { analyzeOverloads } from "../dist/ast/overloads.js";
import { runCli } from "../dist/cli.js";

function checkSource(source, ruleset, ruleName) {
  const dir = mkdtempSync(join(tmpdir(), "messcript-method-identity-"));
  try {
    const file = join(dir, "input.ts");
    writeFileSync(file, source);
    let stdout = "";
    let stderr = "";
    const status = runCli([file, "json", ruleset, "--only", ruleName], {
      stdout: new Writable({
        write(chunk, _encoding, callback) {
          stdout += chunk.toString();
          callback();
        },
      }),
      stderr: new Writable({
        write(chunk, _encoding, callback) {
          stderr += chunk.toString();
          callback();
        },
      }),
    });
    assert.equal(stderr, "");
    const report = JSON.parse(stdout);
    assert.deepEqual(report.errors, []);
    assert.equal(status, report.findings.length === 0 ? 0 : 2);
    return report.findings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [rule, name, body] of [
  ["ShortMethodName", "go", "return;"],
  ["CamelCaseMethodName", "bad_name", "return;"],
  ["BooleanGetMethodName", "getReady", "return true;"],
]) {
  test(`${rule} reports quoted and identifier overloads once and honors implementation suppression`, () => {
    const signature = rule === "BooleanGetMethodName" ? "boolean" : "void";
    const source = `export class Job {
  '${name}'(): ${signature};
  ${name}(): ${signature} { ${body} }
}
`;
    const findings = checkSource(source, "typescript,controversial", rule);
    assert.deepEqual(findings.map((finding) => finding.line), [2]);
    assert.match(findings[0].message, new RegExp(name));
    const suppressed = source.replace(
      `  ${name}():`,
      `  // messcript-disable-next-line ${rule}\n  ${name}():`,
    );
    assert.deepEqual(checkSource(suppressed, "typescript,controversial", rule), []);
  });
}

test("literal overload groups retain every declaration line and the implementation", () => {
  const file = ts.createSourceFile("input.ts", `export class Job {
  'go'(): void;
  "\\u0067o"(delay: number): void;
  go(delay?: number): void { void delay; }
  static "go"(): void;
  static go(): void {}
  123(): void;
  "123"(): void {}
}
`, ts.ScriptTarget.Latest, true);
  const groups = analyzeOverloads(file).callableGroups;
  assert.deepEqual(groups.map((group) => group.declarationLines), [[2, 3, 4], [5, 6], [7, 8]]);
  assert.deepEqual(groups.map((group) => group.declarations.length), [3, 2, 2]);
  assert.deepEqual(groups.map((group) => group.implementation?.getText(file)), [
    "go(delay?: number): void { void delay; }",
    "static go(): void {}",
    '"123"(): void {}',
  ]);
});

for (const rule of ["TooManyMethods", "TooManyPublicMethods"]) {
  test(`${rule} groups literal overloads and counts ambient static and instance methods separately`, () => {
    const dir = mkdtempSync(join(tmpdir(), "messcript-method-threshold-"));
    try {
      const ruleset = join(dir, "rules.xml");
      const source = `export declare class Vec {
  static 'of'(value: string): Vec;
  static of(value: number): Vec;
  "of"(value: string): Vec;
  of(value: number): Vec;
  map(): Vec;
}
`;
      for (const [maximum, expectedCount] of [[2, 1], [3, 0]]) {
        writeFileSync(ruleset, `<ruleset name="methods">
  <rule ref="codesize/${rule}">
    <properties><property name="maxmethods" value="${maximum}" /></properties>
  </rule>
</ruleset>`);
        const findings = checkSource(source, ruleset, rule);
        assert.equal(findings.length, expectedCount);
        if (expectedCount !== 0) {
          assert.match(findings[0].message, /class Vec has 3 /);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("class expressions group literal overloads but keep private and computed names distinct", () => {
  const source = `declare const key: unique symbol;
export const Job = class {
  'go'(): void;
  go(): void {}
  static go(): void {}
  #go(): void {}
  [key](): void {}
};
`;
  const findings = checkSource(source, "typescript", "ShortMethodName");
  assert.deepEqual(findings.map((finding) => finding.line), [3, 5, 6]);
});
