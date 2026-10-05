import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { componentRulesets, getRuleDefinition, indexRuleDefinitions, runGlobalVariable, runRule } from "../dist/rules/catalog.js";

const fixture = `
var legacyCounter = 0;
legacyCounter += 1;
export const lowercase_constant = 1;
export class A {
  private unusedField = 1;
  public A() {}
  public getFlag(): boolean { return true; }
  public Bad_Method(): void {}
  public Bad_Property = 1;
  private unusedMethod(): void {}
  public run(enabled: boolean, unused: number): void {
    let x = 1;
    let not_camel = 2;
    let reallyLongVariableNameThatKeepsOnGoingForever = 3;
    if (enabled) {
      console.log(x);
    } else {
      process.exit(1);
    }
    if ((x = 2)) {}
    const values = { a: 1, a: 2 };
    for (let i = 0; i < [1].length; i++) {}
    try { x++; } catch {}
    Math.max(1, 2);
    debugger;
  }
}
export class Bad_Class_Name_That_Is_Quite_Long_Indeed_And_Then_Some {}
export function f(bad_param, b, c, d, e, f2, g, h, i, j, k): void {}
export class Split {
  private left = 1;
  private right = 2;
  public writeLeft(): void { this.left += 1; }
  public writeRight(): void { this.right += 1; }
  public build(): Dependency { return new Dependency(); }
}
export function readsGlobal(): string { return process.env.HOME ?? ""; }
`;

function sourceFile() {
  return ts.createSourceFile("registry.ts", fixture, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// Size and complexity thresholds lowered so those rules also fire on a small fixture.
const loweredThresholds = {
  CyclomaticComplexity: { reportlevel: "1" },
  NPathComplexity: { minimum: "1" },
  ExcessiveMethodLength: { minimum: "1" },
  ExcessiveClassLength: { minimum: "1" },
  ExcessivePublicCount: { minimum: "1" },
  TooManyFields: { maxfields: "1" },
  TooManyMethods: { maxmethods: "1" },
  TooManyPublicMethods: { maxmethods: "1" },
  ExcessiveClassComplexity: { maximum: "1" },
  CouplingBetweenObjects: { maximum: "1" },
};

// GlobalVariable runs across files through runGlobalVariable; GotoStatement has no JavaScript construct to report.
const inertRunners = new Set(["GlobalVariable", "GotoStatement"]);

function definition(name) {
  return { name, priority: 1, properties: {}, run: () => [] };
}

test("registry rejects definitions whose names differ only by case", () => {
  assert.throws(
    () => indexRuleDefinitions([definition("SameRule"), definition("samerule")]),
    /Duplicate rule definition: samerule/,
  );
});

test("registry indexes each definition by its case-folded name", () => {
  const first = definition("FirstRule");
  const second = definition("SecondRule");
  const index = indexRuleDefinitions([first, second]);

  assert.equal(index.get("firstrule"), first);
  assert.equal(index.get("secondrule"), second);
  assert.equal(index.size, 2);
});

test("every component ruleset rule resolves to a definition carrying its own name", () => {
  for (const [rulesetName, ruleNames] of Object.entries(componentRulesets)) {
    for (const ruleName of ruleNames) {
      const resolved = getRuleDefinition(ruleName);
      assert.ok(resolved, `${rulesetName}/${ruleName}`);
      assert.equal(resolved.name, ruleName, `${rulesetName}/${ruleName}`);
    }
  }
});

test("every component ruleset rule runs its own finder", () => {
  const file = sourceFile();
  const ruleNames = new Set(Object.values(componentRulesets).flat());
  const firing = [];
  for (const ruleName of ruleNames) {
    const resolved = getRuleDefinition(ruleName);
    const selection = { name: ruleName, rulesetName: "t", properties: loweredThresholds[ruleName] ?? {} };
    const findings = runRule(resolved, selection, file, { isTestFile: false });
    for (const finding of findings) {
      assert.equal(finding.ruleName, ruleName, `${ruleName} emitted ${finding.ruleName}`);
    }
    if (findings.length > 0) {
      firing.push(ruleName);
    }
  }

  const expected = [...ruleNames].filter((ruleName) => !inertRunners.has(ruleName));
  assert.deepEqual(firing.sort(), expected.sort());
});

test("GlobalVariable reports through the cross-file runner under its own name", () => {
  const resolved = getRuleDefinition("GlobalVariable");
  const findings = runGlobalVariable(resolved, { name: "GlobalVariable", rulesetName: "t", properties: {} }, [sourceFile()]);

  assert.ok(findings.length > 0);
  assert.ok(findings.every((finding) => finding.ruleName === "GlobalVariable"));
});
