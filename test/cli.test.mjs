import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(repoRoot, "test", "fixtures");
let consumerRoot;
let workspaceRoot;
let scanRoot;
let executable;

before(() => {
  consumerRoot = mkdtempSync(join(tmpdir(), "messcript-acceptance-"));
  const packageDestination = join(consumerRoot, "package");
  mkdirSync(packageDestination);
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--loglevel", "silent", "--pack-destination", packageDestination],
      { cwd: repoRoot, encoding: "utf8" },
    ),
  );
  const packageTarball = join(packageDestination, packed[0].filename);

  execFileSync(
    "npm",
    ["init", "--yes", "--scope", "acceptance"],
    { cwd: consumerRoot, stdio: "ignore" },
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", packageTarball],
    { cwd: consumerRoot, stdio: "ignore" },
  );
  executable = join(consumerRoot, "node_modules", ".bin", "messcript");

  workspaceRoot = mkdtempSync(join(tmpdir(), "messcript-workspace-"));
  scanRoot = join(workspaceRoot, "tests", "project");
  mkdirSync(scanRoot, { recursive: true });
  const complexSource = readFileSync(join(fixturesRoot, "complex.ts"), "utf8");
  const malformedSource = readFileSync(join(fixturesRoot, "malformed.ts"), "utf8");
  const customSource = complexSource.replace("value: number", "value").replace("): number", ")");
  const policySource = `export function policy(value: number): number {
  const qz = value;
  const descriptiveVariableName = value;
  return qz + descriptiveVariableName;
}
`;
  const typescriptPolicySource = `declare namespace Ambient {
  type Value = string;
}

interface Contract {
  run(value: string): string;
}

enum Status { Ready, Done }

abstract class AbstractContract {
  abstract run(value: string): string;
}

class OverloadedContract implements Contract {
  constructor(public readonly value: string) {}
  run(value: string): string;
  run(value: number): string;
  run(value: string | number): string { return String(value); }
}

import type { ExternalType } from "missing-dependency";
export type Alias = ExternalType | Ambient.Value;
`;
  const suppressionSource = `// messcript-disable-next-line CyclomaticComplexity
${complexSource}
// eslint-disable-next-line CyclomaticComplexity
${complexSource.replace("complex(", "complexAgain(")}`;
  const suppressedOnlySource = `// messcript-disable-next-line CyclomaticComplexity
${complexSource}`;
  const regionSuppressionSource = `// messcript-disable CyclomaticComplexity
${complexSource.replace("complex(", "complexOne(")}
// messcript-disable CyclomaticComplexity, npathcomplexity
${complexSource.replace("complex(", "complexTwo(")}
// messcript-enable NPathComplexity
// messcript-enable CyclomaticComplexity
${complexSource.replace("complex(", "complexThree(")}
// messcript-enable CyclomaticComplexity
${complexSource.replace("complex(", "complexFour(")}
// messcript-disable-next-line
// eslint-disable-next-line CyclomaticComplexity
${complexSource.replace("complex(", "complexFive(")}
export const veryLongVariableNameThatTriggersLongVariable = 1;`;
  const npathSource = `export function npathExample(value: number): number {
  if (value > 0) value += 1;
  if (value > 1) value += 1;
  if (value > 2) value += 1;
  if (value > 3) value += 1;
  if (value > 4) value += 1;
  if (value > 5) value += 1;
  if (value > 6) value += 1;
  if (value > 7) value += 1;
  return value;
}

export function npathNegative(value: number): number {
  if (value > 0) value += 1;
  return value;
}

export function decisionSyntax(value: { next?: () => number } | null): number {
  const next = value?.next?.();
  return next ?? 0;
}

export function npathInitializers(value: { next?: number } | null): number {
  const one = value?.next;
  const two = value?.next;
  const three = value?.next;
  const four = value?.next;
  const five = value?.next;
  const six = value?.next;
  const seven = value?.next;
  const eight = value?.next;
  return one + two + three + four + five + six + seven + eight;
}

export function nullishNPath(value: number | null): number {
  const one = value ?? 0;
  const two = value ?? 0;
  const three = value ?? 0;
  const four = value ?? 0;
  const five = value ?? 0;
  const six = value ?? 0;
  const seven = value ?? 0;
  const eight = value ?? 0;
  return one + two + three + four + five + six + seven + eight;
}
`;
  const parameterSource = `export function manyParameters(first, second, third, fourth, fifth, sixth, seventh, eighth, ninth, tenth, eleventh) {
  return first;
}

export function exactParameterThreshold(first, second, third, fourth, fifth, sixth, seventh, eighth, ninth, tenth) {
  return first;
}

export function boundaryParameters({ first, second } = {}, third = 3, fourth = 4, fifth = 5, sixth = 6, seventh = 7, eighth = 8, ninth = 9, ...rest) {
  return first + second + third + fourth + fifth + sixth + seventh + eighth + ninth + rest.length;
}

export function typedThis(this: unknown, first, second, third, fourth, fifth, sixth, seventh, eighth, ninth) {
  return first + ninth;
}

export function idiomaticParameters({ first, second } = {}, ...rest) {
  return first + second + rest.length;
}
`;
  const longSource = [
    "export function shortMethod() { return 1; }",
    "export function longFunction() {",
    ...Array.from({ length: 100 }, (_, index) => `  const line${index} = ${index};`),
    "}",
  ].join("\n");
  const buildLargeClass = ({ typescript, name = "LargeJavaScript" }) => {
    const header = typescript ? "export class LargeTypeScript {" : `export const ${name} = class {`;
    const fields = [
      ...Array.from({ length: 18 }, (_, index) => `  public field${index} = ${index};`.replace("public ", typescript ? "public " : "")),
      typescript ? "  private hidden = 0;" : "  #hidden = 0;",
      ...(typescript ? [] : ["  static extra = 0;"]),
    ];
    const constructor = typescript
      ? [
          "  constructor(public promoted: number) {",
          "    if (promoted) return;",
          "    return;",
          "  }",
        ]
      : [
          "  constructor() {",
          "    if (this.field0) return;",
          "    return;",
          "  }",
        ];
    const methods = Array.from({ length: 25 }, (_, index) => [
      typescript ? `  method${index}(value: number): number {` : `  method${index}(value) {`,
      "    if (value) return 1;",
      "    return 0;",
      "  }",
    ]).flat();
    return [
      header,
      ...fields,
      ...constructor,
      ...methods,
      ...Array.from({ length: 900 }, (_, index) => `  // filler ${index}`),
      "}",
    ].join("\n");
  };
  const classSource = `${buildLargeClass({ typescript: true })}

${buildLargeClass({ typescript: false })}

export class IdiomaticTypeScript {
  private secret = 0;
  static count = 0;
  [Symbol.iterator](): Iterator<number> { return [][Symbol.iterator](); }
  get value(): number { return this.secret; }
  set value(next: number) { this.secret = next; }
}

export const IdiomaticJavaScript = class {
  #secret = 0;
  static count = 0;
  [Symbol.iterator]() { return [][Symbol.iterator](); }
  get value() { return this.#secret; }
  set value(next) { this.#secret = next; }
};

class OverloadDeclarations {
${Array.from({ length: 20 }, (_, index) => `  private run${index}(value: string): string;\n  private run${index}(value: number): string;\n  private run${index}(value: string | number): string { return String(value); }`).join("\n")}
}

class AccessorHeavy {
${Array.from({ length: 30 }, (_, index) => `  get getter${index}() { return ${index}; }`).join("\n")}
}

interface NotAClass { first: string; second(): void; }
type TypeLiteral = { first: string; second(): void };
declare class AmbientDeclaration { readonly value: string; run(): void; }
abstract class AbstractDeclaration { protected value = 0; abstract run(): void; }
`;
  const javascriptClassSource = `${buildLargeClass({ typescript: false, name: "LargeJavaScriptFile" })}

export const IdiomaticJavaScriptFile = class {
  #secret = 0;
  static count = 0;
  [Symbol.iterator]() { return [][Symbol.iterator](); }
  get value() { return this.#secret; }
  set value(next) { this.#secret = next; }
};
`;
  const namingSource = `export class X {
  static readonly bad_constant = 1;
  X() {}
  getFlag(): boolean { return true; }
  isReady(): boolean { return false; }
  getNumber(): number { return 1; }
  [computedName]() {}
}

export interface Q {}
export interface ThisIsAnExcessivelyLongInterfaceNameThatNeedsRefactoring {}
export class ThisIsAnExcessivelyLongClassNameThatNeedsRefactoring {}

export function a() {}
export function callbackRunner(cb, i, x, err, { short: b, index: j, error: problem }) {
  const longVariableNameThatExceedsTheDefaultLimit = b;
  const { value: c } = { value: 1 };
  const bad_local_constant = 1;
  const T = 1;
  return cb || i || x || err || problem || longVariableNameThatExceedsTheDefaultLimit || c || T || bad_local_constant;
}

export const bad_constant_name = 1;
export const GOOD_CONSTANT = 2;
export const A = () => null;
export function useThing() { return true; }
type Box<T> = { value: T };
class ComputedNames {
  [computedName]() {}
  [anotherVeryLongComputedNameThatShouldBeIgnored]() {}
}
`;
  const javascriptNamingSource = `export class J {
  #x = 0;
  getFlag() { return !!this.#x; }
  [computedName]() {}
}

export function b() {}
export const bad_js_constant = 1;
export const A = () => null;
`;
  const controversialSource = `export class bad_class {
  bad_property = 1;
  #privateField = 0;
  #bad_field = 1;
  bad_method(bad_parameter, goodParameter, { bad_destructured_parameter }) {
    const bad_variable = 1;
    const goodVariable = 2;
    return bad_variable + goodVariable + bad_parameter + goodParameter + bad_destructured_parameter;
  }
  #bad_method() {}
  [computed_property]() {}
  [computed_method]() {}
}

export interface bad_interface {
  bad_property: string;
  bad_method(bad_parameter: string): void;
}
type TypeAlias = {
  bad_property: string;
  bad_method(bad_parameter: string): void;
};

export class GoodClass {
  goodProperty = 1;
  goodMethod(goodParameter) { const goodVariable = goodParameter; return goodVariable; }
  #privateField = 0;
  [computed_property]() {}
}
`;
  const controversialJavaScriptSource = `export class bad_js_class {
  bad_js_property = 1;
  bad_js_method(bad_js_parameter) {
    const bad_js_variable = 1;
    return bad_js_variable + bad_js_parameter;
  }
  [computed_js_property]() {}
}
`;
  const unusedSource = `export class UnusedTypeScript {
  private unusedField = 1;
  private usedField = 2;
  private unusedParameterProperty = 3;
  private #unusedPrivate = 4;
  private #usedPrivate = 5;
  private unusedMethod() { return 1; }
  private usedMethod() { return this.usedField; }
  private overload(value: string): string;
  private overload(value: number): string;
  private overload(value: string | number): string { return String(value); }

  constructor(private parameterProperty: number, private parameterField: number) {
    this.#usedPrivate;
    this.usedMethod();
    this.parameterProperty;
  }

  run(usedParameter, unusedParameter, _ignoredParameter) {
    const neverUsedLocal = 1;
    const { used: usedDestructured, unused: unusedDestructured } = { used: 2, unused: 3 };
    const captured = usedDestructured;
    type CapturedType = typeof captured;
    this.overload(1);
    try {
      return usedParameter + usedDestructured + this.#usedPrivate + this.parameterField;
    } catch (unusedError) {
      return captured;
    }
  }
}

function closure(usedParameter, unusedClosureParameter, _ignoredClosureParameter) {
  const capturedByClosure = 1;
  return () => capturedByClosure + usedParameter;
}

function recursive(value) {
  return value > 0 ? recursive(value - 1) : 0;
}

declare class AmbientUnused {
  private unusedField: number;
  private unusedMethod(): void;
}
`;
  const unusedJavaScriptSource = `export class UnusedJavaScript {
  #unusedField = 1;
  #usedField = 2;
  #unusedMethod() { return 1; }
  #usedMethod() { return this.#usedField; }
  run(unusedParameter, _ignoredParameter) {
    const neverUsedLocal = 1;
    this.#usedMethod();
    return this.#usedField;
  }
}
`;
  const cleanCodeSource = `export class CleanCodeTypeScript {
  public run(flag: boolean, value: number) {
    if (flag) {
      return value;
    } else {
      return 0;
    }
  }

  public readUntil(input: string) {
    let result: string | undefined;
    while ((result = input)) {
      return result;
    }
    do {
      result = input;
    } while ((result = input));
    return result;
  }

  public duplicateKeys() {
    return { alpha: 1, "alpha": 2, ["beta"]: 3, beta: 4, [dynamicKey]: 5, [dynamicKey]: 6 };
  }
}

export function staticCall(enabled = false) {
  if (enabled) {
    return Logger.log("message");
  }
  return 0;
}

export function cleanNegative(value: number, enabled: boolean) {
  if (value > 0) {
    return enabled;
  } else if (value < 0) {
    return false;
  }
  return true;
}

const cleanObject = { [dynamicKey]: 1, [anotherKey]: 2 };

interface CleanCodeInterface { run(flag: boolean): void; }
type CleanCodeType = { run(flag: boolean): void };
declare class AmbientCleanCode { run(flag: boolean): void; }
abstract class AbstractCleanCode { abstract run(flag: boolean): void; }
`;
const cleanCodeJavaScriptSource = `export class CleanCodeJavaScript {
  run(flag = true, value) {
    if (flag) return value;
    else return 0;
  }
}

export function javascriptAssignment(input) {
  let result;
  if ((result = input)) return result;
  return Logger.log("message");
}

export const javascriptObject = { "key": 1, key: 2, [dynamicKey]: 3, [dynamicKey]: 4 };
`;
  const designSource = `export function designRules(items, value) {
  if (value === 0) {
    process.exit(1);
  }
  for (let index = 0; index < items.length; index += 1) {
    console.log(items[index]);
  }
  while (items.count() > 0) {
    items.pop();
  }
  try {
    return value;
  } catch (error) {
  }
}

// TODO: remove development marker
export function designNegative(items) {
  const count = items.length;
  for (let index = 0; index < count; index += 1) {
    return items[index];
  }
  try {
    return items;
  } catch (error) {
    return error;
  }
}

export function gotoIsHarmless() {
  return "goto";
}
`;
  const designTypeScriptSource = `interface DesignInterface { run(): void; }
type DesignFunction = () => void;
declare class AmbientDesign { run(): void; }

export function designTypeNegative(items: { length: number }) {
  const itemCount = items.length;
  for (let index = 0; index < itemCount; index += 1) {
    return index;
  }
}
`;
  const cohesionTypeScriptSource = `export class DisjointTypeScript {
  private left = 0;
  private right = 0;
  addLeft() { this.left += 1; }
  addRight() { this.right += 1; }
}

export class CohesiveTypeScript {
  private left = 0;
  private right = 0;
  addLeft() { this.left += 1; }
  addRight() { this.right += 1; }
  leftValue() { return this.left + 1; }
  rightValue() { return this.right + 1; }
  total() { return this.leftValue() + this.rightValue(); }
}

export class AccessorTypeScript {
  private host = "";
  private port = 0;
  get hostName() { return this.host; }
  set hostName(value) { this.host = value; }
  get portNumber() { return this.port; }
  set portNumber(value) { this.port = value; }
}

interface CohesionInterface { run(): void; }
declare class AmbientCohesion { run(): void; }
class OverloadCohesion {
  run(value: string): string;
  run(value: number): string;
  run(value: string | number) { return String(value); }
}
`;
  const cohesionJavaScriptSource = `export class DisjointJavaScript {
  #left = 0;
  #right = 0;
  addLeft() { this.#left += 1; }
  addRight() { this.#right += 1; }
}

export const CohesiveJavaScript = class {
  #left = 0;
  #right = 0;
  addLeft() { this.#left += 1; }
  addRight() { this.#right += 1; }
  leftValue() { return this.#left + 1; }
  rightValue() { return this.#right + 1; }
  total() { return this.leftValue() + this.rightValue(); }
};
`;
  const globalVariableTypeScriptSource = `import type { ImportedType } from "external";
import importedValue from "external-value";

export let mutableState = 0;
export var assignedLater;
export let objectState = { value: 0 };
export let neverMutated = 0;
export const immutableState = 0;
declare let ambientState: number;

export class GlobalState {
  static count = 0;
  static readonly immutable = 1;
  static #privateCount = 0;

  static increment() {
    this.count += 1;
    this.#privateCount++;
  }
}

class NeverMutated {
  static count = 0;
}

function mutateState() {
  mutableState = 1;
  assignedLater += 1;
  objectState.value = 1;
  GlobalState.count++;
}
`;
  const globalVariableScriptSource = `var sharedAcrossFiles = 0;
`;
  const globalVariableMutationSource = `sharedAcrossFiles += 1;
`;
  const couplingImports = Array.from(
    { length: 13 },
    (_, index) => `import type { Dependency${index} } from "./dependency-${index}";`,
  ).join("\n");
  const couplingFields = Array.from(
    { length: 13 },
    (_, index) => `  field${index}: Dependency${index};`,
  ).join("\n");
  const couplingSource = `${couplingImports}
export class Coupled extends BaseClass implements Contract {
  @Injectable()
${couplingFields}
  unimported: ExternalType;
  run(value: Dependency0): Dependency1 {
    return new Dependency2();
  }
}

export const CommonJsDependency = require("./commonjs-dependency");
module.exports = Coupled;
`;
  const couplingNegativeSource = `import type { TypeOnlyDependency } from "./type-only";

interface CouplingInterface { run(value: string): number; }
type CouplingType = { value: boolean };
declare class AmbientCoupling { run(): void; }
namespace CouplingNamespace { export class Nested { value: string = ""; } }

export class IdiomaticCoupling {
  value: string = "";
  values: Array<string> = [];
  run(value: number): number { return value; }
}
`;
  const decisionMetricsSource = `export function logicalNPath(value) {
  if (value && value) {}
  if (value && value) {}
  if (value && value) {}
  if (value && value) {}
  if (value && value) {}
  if (value && value) {}
  if (value && value) {}
  if (value && value) {}
  return value;
}

export function conditionalNPath(value) {
  const one = value ? 1 : 0;
  const two = value ? 1 : 0;
  const three = value ? 1 : 0;
  const four = value ? 1 : 0;
  const five = value ? 1 : 0;
  const six = value ? 1 : 0;
  const seven = value ? 1 : 0;
  const eight = value ? 1 : 0;
  return one + two + three + four + five + six + seven + eight;
}

export function loopNPath(value) {
  let index = 0;
  for (; index < value && value; index += 1) {}
  for (; index < value && value; index += 1) {}
  for (; index < value && value; index += 1) {}
  for (; index < value && value; index += 1) {}
  for (; index < value && value; index += 1) {}
  for (; index < value && value; index += 1) {}
  return index;
}

export function switchNPath(value) {
  switch (value) { case 1: break; case 2: break; default: break; }
  switch (value) { case 1: break; case 2: break; default: break; }
  switch (value) { case 1: break; case 2: break; default: break; }
  switch (value) { case 1: break; case 2: break; default: break; }
  switch (value) { case 1: break; case 2: break; default: break; }
  return value;
}

export function catchNPath(value) {
  try { value; } catch { value; }
  try { value; } catch { value; }
  try { value; } catch { value; }
  try { value; } catch { value; }
  try { value; } catch { value; }
  try { value; } catch { value; }
  try { value; } catch { value; }
  try { value; } catch { value; }
  return value;
}
`;
  const focusedRuleset = `<?xml version="1.0"?>
<ruleset name="focused">
  <rule ref="rulesets/codesize.xml">
    <exclude name="NPathComplexity" />
    <priority>2</priority>
    <properties><property name="maximum" value="1" /></properties>
  </rule>
  <rule ref="rulesets/naming.xml/LongVariable">
    <priority>1</priority>
    <properties><property name="maximum" value="12" /></properties>
  </rule>
</ruleset>
`;
  const nestedRuleset = `<ruleset name="nested">
  <ruleset name="Naming"><exclude name="ShortClassName" /></ruleset>
</ruleset>
`;
  const shortReferenceRuleset = `<ruleset name="short-reference">
  <rule ref="CoDeSiZe"><exclude name="NPathComplexity" /></rule>
  <ruleset ref="nAmInG"><exclude name="ShortClassName" /></ruleset>
</ruleset>
`;
  const nestedFileRuleset = `<ruleset name="nested-file">
  <rule ref="./ChIlD.XML" />
</ruleset>
`;
  const childRuleset = `<ruleset name="child">
  <rule ref="NaMiNg/LongVariable" />
</ruleset>
`;
  const unknownReferenceRuleset = `<ruleset name="warning-only">
  <rule ref="rulesets/codesize.xml/NoSuchRule" />
  <rule ref="rulesets/codesize.xml/CyclomaticComplexity" />
</ruleset>
`;
  const unknownPathReferenceRuleset = `<ruleset name="unknown-path">
  <rule ref="rulesets/missing.xml/LongVariable" />
  <rule ref="rulesets/codesize.xml/CyclomaticComplexity" />
</ruleset>
`;
  const unknownDirectRuleRuleset = `<ruleset name="invalid">
  <rule name="NoSuchRule" />
</ruleset>
`;
  const duplicateRuleset = `<ruleset name="duplicate">
  <rule ref="rulesets/codesize.xml" />
  <rule name="cyclomaticcomplexity">
    <priority>1</priority>
    <properties><property name="maximum" value="100" /></properties>
  </rule>
</ruleset>
`;
  const writeScanFixture = (relativePath, contents) => {
    const path = join(scanRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  writeScanFixture("src/main.ts", complexSource);
  writeScanFixture("src/policy.ts", policySource);
  writeScanFixture("src/typescript-policy.ts", typescriptPolicySource);
  writeScanFixture("src/ampersand&.ts", complexSource);
  writeScanFixture("src/suppressions.ts", suppressionSource);
  writeScanFixture("src/suppressed-only.ts", suppressedOnlySource);
  writeScanFixture("src/region-suppressions.ts", regionSuppressionSource);
  writeScanFixture("src/main.test.ts", complexSource);
  writeScanFixture("src/custom.source", customSource);
  writeScanFixture("src/broken.ts", malformedSource);
  writeScanFixture("src/npath.ts", npathSource);
  writeScanFixture("src/parameters.ts", parameterSource);
  writeScanFixture("src/long.ts", longSource);
  writeScanFixture("src/classes.ts", classSource);
  writeScanFixture("src/classes.js", javascriptClassSource);
  writeScanFixture("src/naming.ts", namingSource);
  writeScanFixture("src/naming.js", javascriptNamingSource);
  writeScanFixture("src/controversial.ts", controversialSource);
  writeScanFixture("src/controversial.js", controversialJavaScriptSource);
  writeScanFixture("src/unused.ts", unusedSource);
  writeScanFixture("src/unused.js", unusedJavaScriptSource);
  writeScanFixture("src/clean-code.ts", cleanCodeSource);
  writeScanFixture("src/clean-code.js", cleanCodeJavaScriptSource);
  writeScanFixture("src/design.js", designSource);
  writeScanFixture("src/design.ts", designTypeScriptSource);
  writeScanFixture("src/cohesion.ts", cohesionTypeScriptSource);
  writeScanFixture("src/cohesion.js", cohesionJavaScriptSource);
  writeScanFixture("src/global-variable.ts", globalVariableTypeScriptSource);
  writeScanFixture("src/global-script-a.js", globalVariableScriptSource);
  writeScanFixture("src/global-script-b.js", globalVariableMutationSource);
  writeScanFixture("src/coupling.ts", couplingSource);
  writeScanFixture("src/coupling-negative.ts", couplingNegativeSource);
  writeScanFixture("src/decision-metrics.ts", decisionMetricsSource);
  writeScanFixture("rulesets/focused.xml", focusedRuleset);
  writeScanFixture("rulesets/nested.xml", nestedRuleset);
  writeScanFixture("rulesets/short-reference.xml", shortReferenceRuleset);
  writeScanFixture("rulesets/nested-file.xml", nestedFileRuleset);
  writeScanFixture("rulesets/child.xml", childRuleset);
  writeScanFixture("rulesets/unknown-reference.xml", unknownReferenceRuleset);
  writeScanFixture("rulesets/unknown-path-reference.xml", unknownPathReferenceRuleset);
  writeScanFixture("rulesets/unknown-direct.xml", unknownDirectRuleRuleset);
  writeScanFixture("rulesets/duplicate.xml", duplicateRuleset);
  writeScanFixture("excluded/complex.ts", complexSource);
  for (const directory of ["node_modules", ".git", "generated", "coverage", ".cache", "build", "dist", "output", ".output"]) {
    writeScanFixture(`${directory}/ignored.ts`, complexSource);
  }
});

after(() => {
  rmSync(consumerRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function runCli(args) {
  return spawnSync(executable, args, { encoding: "utf8" });
}

test("the packed package declares its executable and Node range", () => {
  const installedPackage = JSON.parse(
    readFileSync(join(consumerRoot, "node_modules", "messcript", "package.json"), "utf8"),
  );

  assert.equal(installedPackage.bin.messcript, "dist/cli.js");
  assert.equal(installedPackage.engines.node, ">=20.11.0");
});

test("the packed executable prints help", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: messcript <paths> <format> <ruleset/);
  assert.equal(result.stderr, "");
});

test("the packed executable prints its package version", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^messcript \d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, "");
});

test("a missing command shape is an operational error", () => {
  const result = runCli([]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required arguments: <paths> <format> <ruleset/);
  assert.equal(result.stdout, "");
});

test("an unknown option is an operational error", () => {
  const result = runCli(["src", "text", "javascript", "--not-a-real-option"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --not-a-real-option/);
  assert.equal(result.stdout, "");
});

test("help does not hide an unknown option", () => {
  const result = runCli(["--help", "--not-a-real-option"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --not-a-real-option/);
  assert.equal(result.stdout, "");
});

test("help does not hide an extra positional argument", () => {
  const result = runCli(["--help", "extra"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected positional argument: extra/);
  assert.equal(result.stdout, "");
});

test("a clean mixed-source directory exits successfully", () => {
  const result = runCli([join(fixturesRoot, "mixed"), "text", "codesize"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("JSON reports include metadata, findings, and processing errors", () => {
  const result = runCli([
    join(scanRoot, "src", "main.ts") + "," + join(scanRoot, "src", "broken.ts"),
    "json",
    "codesize",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.tool, { name: "messcript", version: "0.1.0" });
  assert.ok(report.findings.some((finding) => finding.ruleName === "CyclomaticComplexity"));
  assert.ok(report.errors.some((error) => error.path.endsWith("broken.ts")));
  assert.equal(report.findings[0].suppressed, false);
});

test("XML, Checkstyle, SARIF, and report files preserve the report contract", () => {
  const source = join(scanRoot, "src", "main.ts");
  const broken = join(scanRoot, "src", "broken.ts");
  const escapedPath = join(scanRoot, "src", "ampersand&.ts");
  const xml = runCli([source, "xml", "codesize", "--only", "CyclomaticComplexity"]);
  const escapedXml = runCli([escapedPath, "xml", "codesize", "--only", "CyclomaticComplexity"]);
  const checkstyle = runCli([source + "," + broken, "checkstyle", "codesize"]);
  const sarif = runCli([
    join(scanRoot, "src", "suppressed-only.ts"),
    "sarif",
    "codesize",
    "--only",
    "CyclomaticComplexity",
    "--strict",
  ]);
  const ordered = runCli([source + "," + escapedPath, "json", "codesize", "--only", "CyclomaticComplexity"]);
  const reversed = runCli([escapedPath + "," + source, "json", "codesize", "--only", "CyclomaticComplexity"]);
  const reportFile = join(workspaceRoot, "report.json");
  writeFileSync(reportFile, "stale report");
  const filed = runCli([source, "json", "codesize", "--only", "CyclomaticComplexity", "--reportfile", reportFile]);

  assert.equal(xml.status, 2);
  assert.match(xml.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml.stdout, /<messcript version="0\.1\.0">/);
  assert.match(xml.stdout, /<finding[^>]+ruleName="CyclomaticComplexity"/);
  assert.equal(xml.stderr, "");
  assert.match(escapedXml.stdout, /ampersand&amp;\.ts/);

  assert.equal(checkstyle.status, 1);
  assert.match(checkstyle.stdout, /^<checkstyle tool="messcript" version="0\.1\.0">/);
  assert.match(checkstyle.stdout, /source="messcript\.CyclomaticComplexity"/);
  assert.match(checkstyle.stdout, /context="function complex\(\)"/);
  assert.match(checkstyle.stdout, /source="messcript\.ProcessingError"/);
  assert.equal(checkstyle.stderr, "");

  assert.equal(sarif.status, 2);
  const sarifReport = JSON.parse(sarif.stdout);
  assert.equal(sarifReport.version, "2.1.0");
  assert.equal(sarifReport.runs[0].tool.driver.name, "messcript");
  assert.equal(sarifReport.runs[0].results[0].ruleId, "CyclomaticComplexity");
  assert.equal(sarifReport.runs[0].results[0].properties.suppressed, true);
  assert.deepEqual(sarifReport.runs[0].results[0].suppressions, [{ kind: "inSource" }]);
  assert.equal(sarifReport.runs[0].results[0].locations[0].physicalLocation.region.startLine, 2);
  assert.equal(sarif.stderr, "");

  assert.equal(ordered.status, 2);
  assert.equal(reversed.status, 2);
  assert.equal(ordered.stdout, reversed.stdout);

  assert.equal(filed.status, 2);
  assert.equal(filed.stdout, "");
  assert.equal(filed.stderr, "");
  const filedReport = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(filedReport.tool.name, "messcript");
  assert.ok(filedReport.findings.length > 0);
});

test("HTML, ANSI, GitHub, and GitLab reports preserve locations and escaping", () => {
  const source = join(scanRoot, "src", "ampersand&.ts");
  const broken = join(scanRoot, "src", "broken.ts");
  const html = runCli([source + "," + broken, "html", "codesize", "--only", "CyclomaticComplexity"]);
  const ansi = runCli([source, "ansi", "codesize", "--only", "CyclomaticComplexity", "--color", "never"]);
  const textAlways = runCli([source, "text", "codesize", "--only", "CyclomaticComplexity", "--color=always"]);
  const textNever = runCli([source, "text", "codesize", "--only", "CyclomaticComplexity", "--color=never"]);
  const github = runCli([source + "," + broken, "github", "codesize", "--only", "CyclomaticComplexity"]);
  const gitlab = runCli([source + "," + broken, "gitlab", "codesize", "--only", "CyclomaticComplexity"]);
  const clean = runCli([join(fixturesRoot, "mixed"), "html", "codesize"]);
  const cleanAnsi = runCli([join(fixturesRoot, "mixed"), "ansi", "codesize"]);
  const cleanGithub = runCli([join(fixturesRoot, "mixed"), "github", "codesize"]);
  const cleanGitlab = runCli([join(fixturesRoot, "mixed"), "gitlab", "codesize"]);
  const strictHtml = runCli([
    join(scanRoot, "src", "suppressed-only.ts"),
    "html",
    "codesize",
    "--only",
    "CyclomaticComplexity",
    "--strict",
  ]);
  const strict = runCli([
    join(scanRoot, "src", "suppressed-only.ts"),
    "gitlab",
    "codesize",
    "--only",
    "CyclomaticComplexity",
    "--strict",
  ]);

  assert.equal(html.status, 1);
  assert.match(html.stdout, /^<!DOCTYPE html>/);
  assert.match(html.stdout, /ampersand&amp;\.ts/);
  assert.match(html.stdout, /Processing errors/);
  assert.equal(html.stderr, "");

  assert.equal(ansi.status, 2);
  assert.match(ansi.stdout, /\u001b\[33m/);
  assert.equal(ansi.stderr, "");
  assert.equal(textAlways.status, 2);
  assert.match(textAlways.stdout, /\u001b\[33m/);
  assert.equal(textNever.status, 2);
  assert.doesNotMatch(textNever.stdout, /\u001b\[/);

  assert.equal(github.status, 1);
  assert.match(github.stdout, /^::warning /m);
  assert.match(github.stdout, /line=1,col=1/);
  assert.match(github.stdout, /title=CyclomaticComplexity \[priority 3\]/);
  assert.match(github.stdout, /context%3A/);
  assert.match(github.stdout, /::error /);
  assert.match(github.stdout, /broken\.ts%3A/);
  assert.equal(github.stderr, "");

  assert.equal(gitlab.status, 1);
  const gitlabReport = JSON.parse(gitlab.stdout);
  assert.ok(gitlabReport.some((entry) => entry.check_name === "CyclomaticComplexity"));
  assert.ok(gitlabReport.some((entry) => entry.check_name === "ProcessingError"));
  const gitlabFinding = gitlabReport.find((entry) => entry.check_name === "CyclomaticComplexity");
  assert.equal(gitlabFinding.location.lines.begin, 1);
  assert.equal(gitlabFinding.severity, "major");
  assert.match(Buffer.from(gitlabFinding.fingerprint, "hex").toString("utf8"), /:1:1:CyclomaticComplexity:/);

  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /messcript report/);
  assert.equal(cleanAnsi.status, 0);
  assert.equal(cleanAnsi.stdout, "");
  assert.equal(cleanGithub.status, 0);
  assert.equal(cleanGithub.stdout, "");
  assert.equal(cleanGitlab.status, 0);
  assert.deepEqual(JSON.parse(cleanGitlab.stdout), []);
  assert.equal(strictHtml.status, 2);
  assert.match(strictHtml.stdout, /suppressed/);
  assert.equal(strict.status, 2);
  assert.equal(JSON.parse(strict.stdout)[0].suppressed, true);
});

test("recommended language policies tune defaults and opinionated opt-ins", () => {
  const input = join(scanRoot, "src", "policy.ts");
  const typescriptInput = join(scanRoot, "src", "typescript-policy.ts");
  const javascript = runCli([input, "text", "javascript", "--only", "LongVariable"]);
  const typescript = runCli([input, "text", "typescript", "--only", "LongVariable"]);
  const component = runCli([input, "text", "naming", "--only", "LongVariable"]);
  const opinionated = runCli([input, "text", "opinionated", "--only", "ShortVariable"]);
  const combined = runCli([input, "text", "javascript,opinionated", "--only", "ShortVariable"]);
  const absent = runCli([input, "text", "javascript", "--enable", "ShortVariable"]);
  const typescriptExceptions = runCli([
    typescriptInput,
    "text",
    "typescript",
    "--only",
    "CyclomaticComplexity,ExcessiveParameterList,ExcessiveMethodLength",
  ]);

  assert.equal(javascript.status, 0);
  assert.equal(javascript.stdout, "");
  assert.equal(typescript.status, 0);
  assert.equal(typescript.stdout, "");
  assert.equal(component.status, 2);
  assert.match(component.stdout, /LongVariable/);
  assert.equal(opinionated.status, 2);
  assert.match(opinionated.stdout, /ShortVariable/);
  assert.equal(combined.status, 2);
  assert.equal((combined.stdout.match(/ShortVariable/g) ?? []).length, 1);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /not present/);
  assert.equal(typescriptExceptions.status, 0);
  assert.equal(typescriptExceptions.stdout, "");
});

test("CyclomaticComplexity reports a stable text finding", () => {
  const result = runCli([join(fixturesRoot, "complex.ts"), "text", "codesize"]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /complex\.ts:\d+:\d+: CyclomaticComplexity \[priority 3\]/);
  assert.match(result.stdout, /function complex\(\)/);
  assert.match(result.stdout, /Cyclomatic Complexity of 13/);
  assert.equal(result.stderr, "");
});

test("named disable-next-line suppressions are omitted unless strict", () => {
  const input = join(scanRoot, "src", "suppressions.ts");
  const onlyInput = join(scanRoot, "src", "suppressed-only.ts");
  const normal = runCli([input, "text", "codesize"]);
  const strict = runCli([input, "text", "codesize", "--strict"]);
  const clean = runCli([onlyInput, "text", "codesize", "--only", "CyclomaticComplexity"]);
  const strictClean = runCli([onlyInput, "text", "codesize", "--only", "CyclomaticComplexity", "--strict"]);

  assert.equal(normal.status, 2);
  assert.equal((normal.stdout.match(/CyclomaticComplexity/g) ?? []).length, 1);
  assert.doesNotMatch(normal.stdout, /suppressed/);
  assert.equal(strict.status, 2);
  assert.equal((strict.stdout.match(/CyclomaticComplexity/g) ?? []).length, 2);
  assert.match(strict.stdout, /CyclomaticComplexity \[priority 3\] \[suppressed\]/);
  assert.equal(strict.stderr, "");
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, "");
  assert.equal(strictClean.status, 2);
  assert.match(strictClean.stdout, /suppressed-only\.ts:2:1: CyclomaticComplexity \[priority 3\] \[suppressed\]/);
});

test("nested named regions preserve unrelated findings and malformed directives", () => {
  const input = join(scanRoot, "src", "region-suppressions.ts");
  const normal = runCli([input, "text", "codesize,naming"]);
  const strict = runCli([input, "text", "codesize,naming", "--strict"]);

  assert.equal(normal.status, 2);
  assert.equal((normal.stdout.match(/CyclomaticComplexity/g) ?? []).length, 2);
  assert.match(normal.stdout, /LongVariable/);
  assert.doesNotMatch(normal.stdout, /suppressed/);
  assert.equal(strict.status, 2);
  assert.equal((strict.stdout.match(/CyclomaticComplexity/g) ?? []).length, 5);
  assert.equal((strict.stdout.match(/\[suppressed\]/g) ?? []).length, 4);
  assert.match(strict.stdout, /LongVariable/);
  assert.equal(strict.stderr, "");
});

test("function metrics report exact positive values and ignore idiomatic parameters", () => {
  const result = runCli([
    [
      join(scanRoot, "src", "npath.ts"),
      join(scanRoot, "src", "long.ts"),
      join(scanRoot, "src", "parameters.ts"),
      join(scanRoot, "src", "decision-metrics.ts"),
    ].join(","),
    "text",
    "codesize",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /NPathComplexity .*NPath complexity of 256/);
  assert.match(result.stdout, /npathInitializers.*NPath complexity of 256/);
  assert.match(result.stdout, /nullishNPath.*NPath complexity of 256/);
  assert.match(result.stdout, /logicalNPath.*NPath complexity of 6561/);
  assert.match(result.stdout, /conditionalNPath.*NPath complexity of 256/);
  assert.match(result.stdout, /loopNPath.*NPath complexity of 729/);
  assert.match(result.stdout, /switchNPath.*NPath complexity of 243/);
  assert.match(result.stdout, /catchNPath.*NPath complexity of 256/);
  assert.match(result.stdout, /ExcessiveMethodLength .*102 lines of code/);
  assert.match(result.stdout, /ExcessiveParameterList .*11 parameters/);
  assert.match(result.stdout, /exactParameterThreshold.*10 parameters/);
  assert.doesNotMatch(result.stdout, /npathNegative.*NPathComplexity/);
  assert.doesNotMatch(result.stdout, /boundaryParameters.*ExcessiveParameterList/);
  assert.doesNotMatch(result.stdout, /typedThis.*ExcessiveParameterList/);
  assert.doesNotMatch(result.stdout, /shortMethod.*ExcessiveMethodLength/);
  assert.doesNotMatch(result.stdout, /idiomaticParameters.*ExcessiveParameterList/);
  assert.equal(result.stderr, "");
});

test("class metrics cover JavaScript and TypeScript classes without declaration noise", () => {
  const result = runCli([join(scanRoot, "src", "classes.ts") + "," + join(scanRoot, "src", "classes.js"), "text", "codesize"]);

  assert.equal(result.status, 2);
  for (const [className, lineCount] of [["LargeTypeScript", 1025], ["LargeJavaScript", 1026], ["LargeJavaScriptFile", 1026]]) {
    assert.match(result.stdout, new RegExp(`ExcessiveClassLength .*${className} .*${lineCount} lines of code`));
    assert.match(result.stdout, new RegExp(`ExcessivePublicCount .*${className} .*45 public methods and attributes`));
    assert.match(result.stdout, new RegExp(`TooManyFields .*${className} .*20 fields`));
    assert.match(result.stdout, new RegExp(`TooManyMethods .*${className} .*26 non-getter- and setter-methods`));
    assert.match(result.stdout, new RegExp(`TooManyPublicMethods .*${className} .*26 public methods`));
    assert.match(result.stdout, new RegExp(`ExcessiveClassComplexity .*${className} .*overall complexity of 52`));
  }
  assert.doesNotMatch(result.stdout, /IdiomaticTypeScript/);
  assert.doesNotMatch(result.stdout, /IdiomaticJavaScript/);
  assert.doesNotMatch(result.stdout, /IdiomaticJavaScriptFile/);
  assert.doesNotMatch(result.stdout, /OverloadDeclarations|AccessorHeavy/);
  assert.doesNotMatch(result.stdout, /NotAClass|TypeLiteral|AmbientDeclaration|AbstractDeclaration/);
  assert.equal(result.stderr, "");
});

test("naming rules cover language roles and idiomatic names", () => {
  const result = runCli([
    join(scanRoot, "src", "naming.ts") + "," + join(scanRoot, "src", "naming.js"),
    "text",
    "naming",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /ShortClassName .*short names like X/);
  assert.match(result.stdout, /ShortClassName .*short names like Q/);
  assert.match(result.stdout, /LongClassName .*ThisIsAnExcessivelyLongClassNameThatNeedsRefactoring/);
  assert.match(result.stdout, /LongClassName .*ThisIsAnExcessivelyLongInterfaceNameThatNeedsRefactoring/);
  assert.match(result.stdout, /ShortVariable .*short names like b/);
  assert.match(result.stdout, /LongVariable .*longVariableNameThatExceedsTheDefaultLimit/);
  assert.match(result.stdout, /ShortMethodName .*short method names like a\(\)/);
  assert.match(result.stdout, /ConstantNamingConventions \[priority 4\].*bad_constant_name/);
  assert.match(result.stdout, /ConstantNamingConventions \[priority 4\].*bad_constant/);
  assert.match(result.stdout, /BooleanGetMethodName \[priority 4\].*getFlag\(\)/);
  assert.match(result.stdout, /ConstructorWithNameAsEnclosingClass/);
  assert.match(result.stdout, /ShortClassName .*short names like J/);
  assert.match(result.stdout, /ShortMethodName .*short method names like b\(\)/);
  assert.match(result.stdout, /ConstantNamingConventions .*bad_js_constant/);
  assert.doesNotMatch(result.stdout, /GOOD_CONSTANT|bad_local_constant|isReady|getNumber|callbackRunner|useThing|computedName|anotherVeryLongComputedNameThatShouldBeIgnored/);
  assert.doesNotMatch(result.stdout, /short names like i|short names like j|short names like x|short names like T/);
  assert.doesNotMatch(result.stdout, /short method names like A\(\)/);
  assert.equal(result.stderr, "");
});

test("controversial rules distinguish camel-case roles and skip computed names", () => {
  const result = runCli([
    join(scanRoot, "src", "controversial.ts") + "," + join(scanRoot, "src", "controversial.js"),
    "text",
    "controversial",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /CamelCaseClassName .*bad_class/);
  assert.match(result.stdout, /CamelCaseClassName .*bad_interface/);
  assert.match(result.stdout, /CamelCasePropertyName .*bad_property/);
  assert.match(result.stdout, /CamelCasePropertyName .*bad_field/);
  assert.match(result.stdout, /CamelCaseMethodName .*bad_method/);
  assert.match(result.stdout, /CamelCaseParameterName .*bad_parameter/);
  assert.match(result.stdout, /CamelCaseParameterName .*bad_destructured_parameter/);
  assert.match(result.stdout, /CamelCaseVariableName .*bad_variable/);
  assert.match(result.stdout, /CamelCaseClassName .*bad_js_class/);
  assert.match(result.stdout, /CamelCasePropertyName .*bad_js_property/);
  assert.match(result.stdout, /CamelCaseMethodName .*bad_js_method/);
  assert.match(result.stdout, /CamelCaseParameterName .*bad_js_parameter/);
  assert.match(result.stdout, /CamelCaseVariableName .*bad_js_variable/);
  assert.doesNotMatch(result.stdout, /GoodClass|goodProperty|goodMethod|goodParameter|goodVariable|privateField|computed_property|computed_method|computed_js_property/);
  assert.equal(result.stderr, "");
});

test("unusedcode rules resolve lexical references without declaration certainty", () => {
  const result = runCli([
    join(scanRoot, "src", "unused.ts") + "," + join(scanRoot, "src", "unused.js"),
    "text",
    "unusedcode",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /UnusedPrivateField .*unusedField/);
  assert.match(result.stdout, /UnusedPrivateField .*unusedParameterProperty/);
  assert.match(result.stdout, /UnusedPrivateField .*unusedPrivate/);
  assert.match(result.stdout, /UnusedPrivateMethod .*unusedMethod/);
  assert.match(result.stdout, /UnusedFormalParameter .*unusedParameter/);
  assert.match(result.stdout, /UnusedFormalParameter .*unusedClosureParameter/);
  assert.match(result.stdout, /UnusedLocalVariable .*neverUsedLocal/);
  assert.match(result.stdout, /UnusedLocalVariable .*unusedDestructured/);
  assert.match(result.stdout, /UnusedLocalVariable .*unusedError/);
  assert.match(result.stdout, /UnusedPrivateField .*#unusedField/);
  assert.match(result.stdout, /UnusedPrivateMethod .*#unusedMethod/);
  assert.match(result.stdout, /UnusedFormalParameter .*unusedParameter/);
  assert.match(result.stdout, /UnusedLocalVariable .*neverUsedLocal/);
  assert.doesNotMatch(result.stdout, /AmbientUnused|such as '#usedField'|such as '#usedPrivate'|such as 'usedField'|such as 'usedPrivate'|such as 'usedMethod'|such as 'overload'|such as 'parameterProperty'|such as 'parameterField'|such as 'usedParameter'|such as '_ignoredParameter'|such as '_ignoredClosureParameter'|such as 'capturedByClosure'|such as 'captured'|such as 'usedDestructured'|such as 'recursive'/);
  assert.equal(result.stderr, "");
});

test("cleancode rules cover executable JavaScript and TypeScript constructs conservatively", () => {
  const result = runCli([
    join(scanRoot, "src", "clean-code.ts") + "," + join(scanRoot, "src", "clean-code.js"),
    "text",
    "cleancode",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /BooleanArgumentFlag \[priority 1\].*boolean flag argument flag/);
  assert.match(result.stdout, /ElseExpression \[priority 1\].*uses an else expression/);
  assert.match(result.stdout, /IfStatementAssignment \[priority 1\].*assigning values/);
  assert.match(result.stdout, /DuplicatedArrayKey \[priority 2\].*alpha/);
  assert.match(result.stdout, /DuplicatedArrayKey \[priority 2\].*beta/);
  assert.match(result.stdout, /StaticAccess \[priority 1\].*Logger/);
  assert.doesNotMatch(result.stdout, /\bCleanCodeInterface\b|\bCleanCodeType\b|\bAmbientCleanCode\b|\bAbstractCleanCode\b/);
  assert.doesNotMatch(result.stdout, /cleanNegative.*ElseExpression|anotherKey|dynamicKey/);
  assert.equal(result.stderr, "");
});

test("design rules cover executable control flow and keep goto inert", () => {
  const result = runCli([
    join(scanRoot, "src", "design.js") + "," + join(scanRoot, "src", "design.ts"),
    "text",
    "design",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /ExitExpression \[priority 1\].*exit expression/);
  assert.match(result.stdout, /CountInLoopExpression \[priority 2\].*length.*for/);
  assert.match(result.stdout, /CountInLoopExpression \[priority 2\].*count.*while/);
  assert.match(result.stdout, /DevelopmentCodeFragment \[priority 2\].*console.log/);
  assert.match(result.stdout, /DevelopmentCodeFragment \[priority 2\].*Development-only marker/);
  assert.match(result.stdout, /EmptyCatchBlock \[priority 2\].*empty catch blocks/);
  assert.doesNotMatch(result.stdout, /GotoStatement|DesignInterface|DesignFunction|AmbientDesign|designTypeNegative/);
  assert.equal(result.stderr, "");
});

test("design global-variable rule reports observed mutable module and static state", () => {
  const result = runCli([
    [
      join(scanRoot, "src", "global-variable.ts"),
      join(scanRoot, "src", "global-script-a.js"),
      join(scanRoot, "src", "global-script-b.js"),
    ].join(","),
    "text",
    "design",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /GlobalVariable \[priority 1\].*mutableState/);
  assert.match(result.stdout, /GlobalVariable \[priority 1\].*assignedLater/);
  assert.match(result.stdout, /GlobalVariable \[priority 1\].*objectState/);
  assert.match(result.stdout, /GlobalVariable \[priority 1\].*count/);
  assert.match(result.stdout, /GlobalVariable \[priority 1\].*sharedAcrossFiles/);
  assert.doesNotMatch(result.stdout, /ImportedType|importedValue|neverMutated|immutableState|ambientState|immutable|NeverMutated/);
  assert.equal(result.stderr, "");
});

test("design coupling rule measures imports, types, heritage, decorators, and require", () => {
  const result = runCli([
    join(scanRoot, "src", "coupling.ts") + "," + join(scanRoot, "src", "coupling-negative.ts"),
    "text",
    "design",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /CouplingBetweenObjects \[priority 2\].*class Coupled/);
  assert.match(result.stdout, /coupling between objects value of (?:1[4-9]|[2-9][0-9])/);
  assert.doesNotMatch(result.stdout, /IdiomaticCoupling|CouplingInterface|CouplingType|AmbientCoupling|CouplingNamespace/);
  assert.equal(result.stderr, "");
});

test("design cohesion rule covers JavaScript and TypeScript classes", () => {
  const result = runCli([
    join(scanRoot, "src", "cohesion.ts") + "," + join(scanRoot, "src", "cohesion.js"),
    "text",
    "design",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /LackOfCohesionOfMethods \[priority 3\].*class DisjointTypeScript.*value of 2/);
  assert.match(result.stdout, /LackOfCohesionOfMethods \[priority 3\].*class DisjointJavaScript.*value of 2/);
  assert.doesNotMatch(result.stdout, /CohesiveTypeScript|CohesiveJavaScript|AccessorTypeScript|CohesionInterface|AmbientCohesion|OverloadCohesion/);
  assert.equal(result.stderr, "");
});

test("custom rulesets compose references, exclusions, priorities, and properties", () => {
  const result = runCli([
    join(scanRoot, "src", "naming.ts") + "," + join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "focused.xml"),
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /CyclomaticComplexity \[priority 2\].*threshold is 1/);
  assert.match(result.stdout, /LongVariable \[priority 1\].*longVariableNameThatExceedsTheDefaultLimit.*under 12/);
  assert.doesNotMatch(result.stdout, /NPathComplexity/);
  assert.equal(result.stderr, "");
});

test("ruleset names and nested exclusions are case-insensitive", () => {
  const builtIn = runCli([join(fixturesRoot, "complex.ts"), "text", "CoDeSiZe"]);
  const combined = runCli([
    join(scanRoot, "src", "naming.ts") + "," + join(fixturesRoot, "complex.ts"),
    "text",
    "codesize,naming",
  ]);
  const nested = runCli([join(scanRoot, "src", "naming.ts"), "text", join(scanRoot, "rulesets", "nested.xml")]);

  assert.equal(builtIn.status, 2);
  assert.equal(combined.status, 2);
  assert.equal(nested.status, 2);
  assert.match(combined.stdout, /CyclomaticComplexity/);
  assert.match(combined.stdout, /ShortMethodName|ShortVariable/);
  assert.doesNotMatch(nested.stdout, /ShortClassName/);
  assert.match(nested.stdout, /LongClassName|ShortMethodName|LongVariable/);
  assert.equal(builtIn.stderr, "");
  assert.equal(nested.stderr, "");
});

test("short built-in and nested custom-file references resolve case-insensitively", () => {
  const short = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "short-reference.xml"),
  ]);
  const nested = runCli([
    join(scanRoot, "src", "naming.ts"),
    "text",
    join(scanRoot, "RULESETS", "NESTED-FILE.XML"),
  ]);

  assert.equal(short.status, 2);
  assert.match(short.stdout, /CyclomaticComplexity/);
  assert.doesNotMatch(short.stdout, /NPathComplexity|ShortClassName/);
  assert.equal(nested.status, 2);
  assert.match(nested.stdout, /LongVariable/);
  assert.equal(nested.stderr, "");
});

test("duplicate rules collapse and later explicit overrides win", () => {
  const result = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "duplicate.xml"),
    "--only",
    "CyclomaticComplexity",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("only, enable, disable, and priority filters select loaded rules", () => {
  const only = runCli([
    join(scanRoot, "src", "npath.ts"),
    "text",
    "codesize",
    "--only",
    "NPathComplexity",
  ]);
  const disabled = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    "codesize",
    "--only",
    "CyclomaticComplexity",
    "--disable",
    "CyclomaticComplexity",
  ]);
  const priority = runCli([
    join(scanRoot, "src", "naming.ts"),
    "text",
    join(scanRoot, "rulesets", "focused.xml"),
    "--minimum-priority",
    "1",
  ]);
  const absent = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    "codesize",
    "--enable",
    "LongVariable",
  ]);
  const invalidPriority = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    "codesize",
    "--minimum-priority",
    "0",
  ]);

  assert.equal(only.status, 2);
  assert.match(only.stdout, /NPathComplexity/);
  assert.doesNotMatch(only.stdout, /CyclomaticComplexity|Excessive/);
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, "");
  assert.equal(priority.status, 2);
  assert.match(priority.stdout, /LongVariable \[priority 1\]/);
  assert.doesNotMatch(priority.stdout, /CyclomaticComplexity/);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /Requested rule 'longvariable' is not present/);
  assert.equal(invalidPriority.status, 1);
  assert.match(invalidPriority.stderr, /expects a priority between 1 and 5/);
});

test("unknown references warn only in verbose mode while unknown direct rules fail", () => {
  const quiet = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "unknown-reference.xml"),
  ]);
  const verbose = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "unknown-reference.xml"),
    "--verbose",
  ]);
  const direct = runCli([
    join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "unknown-direct.xml"),
  ]);

  assert.equal(quiet.status, 2);
  assert.match(quiet.stdout, /CyclomaticComplexity/);
  assert.equal(quiet.stderr, "");
  assert.equal(verbose.status, 2);
  assert.match(verbose.stderr, /Warning: Unknown referenced rule 'NoSuchRule'/);
  assert.equal(direct.status, 1);
  assert.equal(direct.stdout, "");
  assert.match(direct.stderr, /Unknown rule 'NoSuchRule'/);
});

test("unknown ruleset paths are warnings and never substitute a known rule", () => {
  const quiet = runCli([
    join(scanRoot, "src", "naming.ts") + "," + join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "unknown-path-reference.xml"),
  ]);
  const verbose = runCli([
    join(scanRoot, "src", "naming.ts") + "," + join(fixturesRoot, "complex.ts"),
    "text",
    join(scanRoot, "rulesets", "unknown-path-reference.xml"),
    "--verbose",
  ]);

  assert.equal(quiet.status, 2);
  assert.match(quiet.stdout, /CyclomaticComplexity/);
  assert.doesNotMatch(quiet.stdout, /LongVariable/);
  assert.equal(quiet.stderr, "");
  assert.equal(verbose.status, 2);
  assert.match(verbose.stderr, /Unknown referenced rule 'LongVariable'/);
});

test("a missing input is an operational error", () => {
  const result = runCli([join(fixturesRoot, "missing.ts"), "text", "codesize"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Input path does not exist/);
  assert.equal(result.stdout, "");
});

test("a parse error is an operational error", () => {
  const result = runCli([join(fixturesRoot, "malformed.ts"), "text", "codesize"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed\.ts.*Could not parse/);
  assert.equal(result.stderr, "");
});

test("discovery is deterministic, recursive, and deduplicates overlapping inputs", () => {
  const expected = runCli([scanRoot, "text", "codesize"]);
  const repeated = runCli([`${scanRoot},${join(scanRoot, "src", "main.ts")},${scanRoot}`, "text", "codesize"]);

  assert.equal(repeated.status, expected.status);
  assert.equal(repeated.stdout, expected.stdout);
  assert.equal(repeated.stderr, expected.stderr);
  assert.match(repeated.stdout, /main\.ts/);
  assert.match(repeated.stdout, /main\.test\.ts/);
  assert.match(repeated.stdout, /ProcessingError/);
  assert.doesNotMatch(repeated.stdout, /node_modules|generated|coverage|\.cache|build|dist/);
});

test("tests are included by default and ignored only when requested", () => {
  const included = runCli([scanRoot, "text", "codesize"]);
  const ignored = runCli([scanRoot, "text", "codesize", "--ignore-tests"]);

  assert.match(included.stdout, /main\.test\.ts/);
  assert.match(ignored.stdout, /main\.ts/);
  assert.doesNotMatch(ignored.stdout, /main\.test\.ts/);
  assert.equal(included.stderr, ignored.stderr);
});

test("suffix overrides and path exclusions control discovery", () => {
  const customSuffix = runCli([scanRoot, "text", "codesize", "--suffixes", ".source"]);
  const excluded = runCli([scanRoot, "text", "codesize", "--exclude", join(scanRoot, "excluded")]);

  assert.equal(customSuffix.status, 2);
  assert.match(customSuffix.stdout, /custom\.source/);
  assert.doesNotMatch(customSuffix.stdout, /main\.ts|main\.test\.ts/);
  assert.doesNotMatch(excluded.stdout, /excluded[\\/]complex\.ts/);
});

test("exit-ignore flags change only status, not report content", () => {
  const withErrors = runCli([scanRoot, "text", "codesize"]);
  const errorsIgnored = runCli([scanRoot, "text", "codesize", "--ignore-errors-on-exit"]);
  const violating = runCli([join(scanRoot, "src", "main.ts"), "text", "codesize"]);
  const violationsIgnored = runCli([join(scanRoot, "src", "main.ts"), "text", "codesize", "--ignore-violations-on-exit"]);
  const allIgnored = runCli([
    scanRoot,
    "text",
    "codesize",
    "--ignore-errors-on-exit",
    "--ignore-violations-on-exit",
  ]);

  assert.equal(withErrors.status, 1);
  assert.equal(errorsIgnored.status, 2);
  assert.equal(errorsIgnored.stdout, withErrors.stdout);
  assert.equal(errorsIgnored.stderr, withErrors.stderr);
  assert.equal(violating.status, 2);
  assert.equal(violationsIgnored.status, 0);
  assert.equal(violationsIgnored.stdout, violating.stdout);
  assert.equal(violationsIgnored.stderr, violating.stderr);
  assert.equal(allIgnored.status, 0);
  assert.equal(allIgnored.stdout, withErrors.stdout);
  assert.equal(allIgnored.stderr, withErrors.stderr);
});
