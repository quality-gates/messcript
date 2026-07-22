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
  const writeScanFixture = (relativePath, contents) => {
    const path = join(scanRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  writeScanFixture("src/main.ts", complexSource);
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
  writeScanFixture("src/decision-metrics.ts", decisionMetricsSource);
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

test("CyclomaticComplexity reports a stable text finding", () => {
  const result = runCli([join(fixturesRoot, "complex.ts"), "text", "codesize"]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /complex\.ts:\d+:\d+: CyclomaticComplexity \[priority 3\]/);
  assert.match(result.stdout, /function complex\(\)/);
  assert.match(result.stdout, /Cyclomatic Complexity of 13/);
  assert.equal(result.stderr, "");
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
