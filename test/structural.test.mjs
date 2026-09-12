import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import { getClassMethods } from "../dist/ast/classes.js";
import { calculateClassComplexity, calculateClassLineCount } from "../dist/metrics/classes.js";
import { calculateNPathComplexity } from "../dist/metrics/complexity.js";
import { calculateCyclomaticComplexity } from "../dist/metrics/cyclomatic.js";
import { calculateLcom4 } from "../dist/metrics/cohesion.js";
import { findCouplingBetweenObjects, properties as couplingProperties } from "../dist/rules/coupling-between-objects.js";
import { findCountInLoopExpression } from "../dist/rules/count-in-loop-expression.js";
import { findCyclomaticComplexity, properties as cyclomaticProperties } from "../dist/rules/cyclomatic-complexity.js";
import { findDevelopmentCodeFragment, properties as developmentProperties } from "../dist/rules/development-code-fragment.js";
import { findDuplicatedArrayKey } from "../dist/rules/duplicated-array-key.js";
import { findElseExpression } from "../dist/rules/else-expression.js";
import { findEmptyCatchBlock } from "../dist/rules/empty-catch-block.js";
import { findExcessiveClassComplexity, properties as classComplexityProperties } from "../dist/rules/excessive-class-complexity.js";
import { findExcessiveClassLength, properties as classLengthProperties } from "../dist/rules/excessive-class-length.js";
import { findExcessiveMethodLength, properties as methodLengthProperties } from "../dist/rules/excessive-method-length.js";
import { findExcessiveParameterList, properties as parameterListProperties } from "../dist/rules/excessive-parameter-list.js";
import { findExcessivePublicCount, properties as publicCountProperties } from "../dist/rules/excessive-public-count.js";
import { findExitExpression } from "../dist/rules/exit-expression.js";
import { findGlobalVariable, properties as globalProperties } from "../dist/rules/global-variable.js";
import { findGotoStatement } from "../dist/rules/goto-statement.js";
import { findIfStatementAssignment } from "../dist/rules/if-statement-assignment.js";
import { findLackOfCohesionOfMethods, properties as cohesionProperties } from "../dist/rules/lack-of-cohesion-of-methods.js";
import { findNPathComplexity, properties as npathProperties } from "../dist/rules/npath-complexity.js";
import { findStaticAccess, properties as staticAccessProperties } from "../dist/rules/static-access.js";
import { findTooManyFields, properties as fieldsProperties } from "../dist/rules/too-many-fields.js";
import { findTooManyMethods, properties as methodsProperties } from "../dist/rules/too-many-methods.js";
import { findTooManyPublicMethods, properties as publicMethodsProperties } from "../dist/rules/too-many-public-methods.js";

function sourceFile(source, fileName = "structural.ts") {
  const scriptKind = fileName.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function messages(findings) {
  return findings.map((finding) => finding.message);
}

test("clean-code and control-flow rules distinguish violations, boundaries, and nested functions", () => {
  const file = sourceFile(`
class Owner {
  run(value) {
    if (value) return 1; else return 0;
  }
  check(value) {
    if (value = next()) return value;
    while (value = next()) value++;
    do { value = 1; } while (value = next());
    return (() => { if (value) return value; else return 0; })();
  }
  static call() { Other.run(); Owner.run(); }
  ignored() { Other.run(); }
}
class Other { static run() {} }
function loops(items, value) {
  for (let i = 0; i < items.length; i += 1) {}
  while (items.size) {}
  do {} while (items.count());
  while (value) { (() => items.length)(); }
}
function exits() { process.exit(1); process.abort(); Deno.exit(1); exit(); }
process.exit(1);
function debug() {
  console.log(value);
  debug.debug(value);
  logger.trace(value);
  // TODO remove this
  /* FIXME remove this too */
}
function catches() {
  try { work(); } catch {}
  try { work(); } catch (error) { return error; }
}
`);

  const elseFindings = findElseExpression(file);
  assert.equal(elseFindings.length, 2);
  assert.match(elseFindings[0].message, /uses an else expression/);
  assert.equal(findIfStatementAssignment(file).length, 3);
  assert.ok(messages(findIfStatementAssignment(file)).every((message) => /assigning values/.test(message)));

  const staticFindings = findStaticAccess(file);
  assert.equal(staticFindings.length, 3);
  assert.match(staticFindings[0].message, /class 'Other'/);
  assert.ok(staticFindings.some((finding) => /class 'Deno'/.test(finding.message)));
  staticAccessProperties.exceptions = "Other,Deno";
  assert.equal(findStaticAccess(file).length, 0);
  staticAccessProperties.exceptions = "";
  staticAccessProperties.ignorepattern = "^ignored";
  assert.equal(findStaticAccess(file).length, 2);
  staticAccessProperties.ignorepattern = "";

  const countFindings = findCountInLoopExpression(file);
  assert.equal(countFindings.length, 3);
  assert.deepEqual(messages(countFindings).sort(), [
    "Avoid using count in do loops.",
    "Avoid using length in for loops.",
    "Avoid using size in while loops.",
  ]);
  assert.equal(findExitExpression(file).length, 2);
  assert.equal(findEmptyCatchBlock(file).length, 1);
  assert.deepEqual(findGotoStatement(file), []);

  const development = findDevelopmentCodeFragment(file);
  assert.equal(development.length, 4);
  assert.equal(development.filter((finding) => finding.context === "function debug()").length, 2);
  developmentProperties["unwanted-functions"] = "logger.trace";
  assert.equal(findDevelopmentCodeFragment(file).length, 5);
  developmentProperties["unwanted-functions"] = "";
  developmentProperties.markers = "NOTE";
  assert.equal(findDevelopmentCodeFragment(file).length, 2);
  developmentProperties.markers = "TODO,FIXME,HACK";
});

test("ElseExpression uses unquoted string-literal method names", () => {
  const file = sourceFile(`
class Service {
  "save"(value: boolean) {
    if (value) return 1;
    else return 0;
  }
}
`);

  const [finding] = findElseExpression(file);
  assert.equal(finding.context, "method save()");
  assert.match(finding.message, /The method save uses an else expression/);
});

test("ElseExpression flags else in module-level statements and class static blocks", () => {
  const file = sourceFile(`let x = 0;
if (x === 1) {
  x = 2;
} else {
  x = 3;
}

export class Example {
  static {
    let y = 0;
    if (y === 1) {
      y = 2;
    } else {
      y = 3;
    }
  }
}
`);

  const findings = findElseExpression(file);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => ({ line: finding.line, context: finding.context, ruleName: finding.ruleName })),
    [
      { line: 4, context: "module", ruleName: "ElseExpression" },
      { line: 13, context: "module", ruleName: "ElseExpression" },
    ],
  );
  assert.ok(findings.every((finding) => /The method module uses an else expression/.test(finding.message)));
});

test("DevelopmentCodeFragment finds marker comments after template expressions with interpolation", () => {
  const file = sourceFile(`
const name = "world";
const greeting = \`hello \${name}\`;
// TODO fix this later
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(file).length, 1);

  const nested = sourceFile(`
const name = "world";
const greeting = \`hello \${\`nested \${name}\`}\`;
// TODO fix this too
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(nested).length, 1);

  const braceInInterpolation = sourceFile(`
const value = \`text \${(() => { return { a: 1 }; })()} more\`;
// TODO after brace-heavy interpolation
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(braceInInterpolation).length, 1);

  const commentBetweenNestedBraceAndRealClose = sourceFile(`
const value = \`outer \${(() => { return 1; })() /* TODO mid-expression */ } tail\`;
// TODO after full expression
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(commentBetweenNestedBraceAndRealClose).length, 2);

  const multipleSubstitutions = sourceFile(`
const x = 1;
const y = 2;
const value = \`a \${x} b \${y} c\`;
// TODO after multiple substitutions
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(multipleSubstitutions).length, 1);

  const noTemplateAtAll = sourceFile(`
function plain() {
  return { a: 1 };
}
// TODO after plain braces, no template ever scanned
`);
  const regexLiteralWithBraces = sourceFile(`
const greeting = \`matched: \${/[{]/.test("2026")}\`;
// TODO after regex with unbalanced brace
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(regexLiteralWithBraces).length, 1);

  const regexLiteralWithSlashEquals = sourceFile(`
const greeting = \`matched: \${/=foo{/.test("=foo{")}\`;
// TODO after regex starting with slash equals
function work() {}
`);
  assert.equal(findDevelopmentCodeFragment(regexLiteralWithSlashEquals).length, 1);
});

test("DevelopmentCodeFragment finds debug calls through literal element access", () => {
  const file = sourceFile(`
console["log"]("debug");
console[\`debug\`]();
debug["debug"]();
logger["trace"]();
console[method]();
logger[method]();
`);

  assert.deepEqual(messages(findDevelopmentCodeFragment(file, "logger.trace")), [
    "The module calls the typical debug function console.log() which is mostly only used during development.",
    "The module calls the typical debug function console.debug() which is mostly only used during development.",
    "The module calls the typical debug function debug.debug() which is mostly only used during development.",
    "The module calls the typical debug function logger.trace() which is mostly only used during development.",
  ]);
});

test("duplicate keys recognize static literals and ignore dynamic keys", () => {
  const file = sourceFile(`
const value = 1;
const object = {
  alpha: 1,
  alpha: 2,
  "beta": 1,
  ["beta"]: 2,
  1: 1,
  [1]: 2,
  true: 1,
  [true]: 2,
  [-1]: 1,
  [-1.0]: 2,
  [value]: 3,
  ...other,
  method() {},
  get method() { return 1; },
};
`);
  const findings = findDuplicatedArrayKey(file);
  assert.equal(findings.length, 6);
  assert.ok(messages(findings).some((message) => /alpha/.test(message)));
  assert.ok(messages(findings).some((message) => /beta/.test(message)));
  assert.ok(messages(findings).some((message) => /-1/.test(message)));
  assert.ok(messages(findings).every((message) => /first declared at line/.test(message)));

  const getterSetter = sourceFile(`
const object = {
  get foo() { return 1; },
  set foo(v) {},
  get bar() { return 1; },
  get bar() { return 2; },
  set baz(v) {},
  set baz(v) {},
  set qux(v) {},
  qux: 1,
};
`);
  const gsFindings = findDuplicatedArrayKey(getterSetter);
  assert.equal(gsFindings.length, 3);
  assert.match(gsFindings[0].message, /bar/);
  assert.match(gsFindings[1].message, /baz/);
  assert.match(gsFindings[2].message, /qux/);
});

test("DuplicatedArrayKey detects BigInt literal and computed null keys", () => {
  const file = sourceFile(`
const object = {
  10n: 1,
  10n: 2,
  [10n]: 3,
  10: 4,
  [null]: 1,
  [null]: 2,
  null: 3,
};
`);
  const findings = findDuplicatedArrayKey(file);
  assert.equal(findings.length, 5);
  assert.deepEqual(
    findings.map((f) => ({ line: f.line, message: f.message })),
    [
      { line: 4, message: "Duplicated array key 10n, first declared at line 3." },
      { line: 5, message: "Duplicated array key [10n], first declared at line 3." },
      { line: 6, message: "Duplicated array key 10, first declared at line 3." },
      { line: 8, message: "Duplicated array key [null], first declared at line 7." },
      { line: 9, message: "Duplicated array key null, first declared at line 7." },
    ],
  );
});

test("DuplicatedArrayKey preserves original declaration line for third and subsequent duplicate keys", () => {
  const file = sourceFile(`
const config = {
  timeout: 100,
  timeout: 200,
  timeout: 300,
  timeout: 400,
};
`);
  const findings = findDuplicatedArrayKey(file);
  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((f) => ({ line: f.line, message: f.message })),
    [
      { line: 4, message: "Duplicated array key timeout, first declared at line 3." },
      { line: 5, message: "Duplicated array key timeout, first declared at line 3." },
      { line: 6, message: "Duplicated array key timeout, first declared at line 3." },
    ],
  );

  const accessorDuplicates = sourceFile(`
const obj = {
  get a() { return 1; },
  get a() { return 2; },
  get a() { return 3; },
  set b(v) {},
  set b(v) {},
  set b(v) {},
  get c() { return 1; },
  set c(v) {},
  c: 1,
  c: 2,
  set d(v) {},
  get d() { return 1; },
  d: 1,
  d: 2,
  e: 1,
  get e() { return 1; },
  set e(v) {},
  e: 2,
};
`);
  const accessorFindings = findDuplicatedArrayKey(accessorDuplicates);
  assert.deepEqual(
    accessorFindings.map((f) => ({ line: f.line, message: f.message })),
    [
      { line: 4, message: "Duplicated array key a, first declared at line 3." },
      { line: 5, message: "Duplicated array key a, first declared at line 3." },
      { line: 7, message: "Duplicated array key b, first declared at line 6." },
      { line: 8, message: "Duplicated array key b, first declared at line 6." },
      { line: 11, message: "Duplicated array key c, first declared at line 9." },
      { line: 12, message: "Duplicated array key c, first declared at line 9." },
      { line: 15, message: "Duplicated array key d, first declared at line 13." },
      { line: 16, message: "Duplicated array key d, first declared at line 13." },
      { line: 18, message: "Duplicated array key e, first declared at line 17." },
      { line: 19, message: "Duplicated array key e, first declared at line 17." },
      { line: 20, message: "Duplicated array key e, first declared at line 17." },
    ],
  );
});

test("CyclomaticComplexity handles deeply nested statements", () => {
  const depth = 830;
  const file = sourceFile(`function nested(value) {${"if (value) {".repeat(depth)}return 0;${"}".repeat(depth)}}`);

  const findings = findCyclomaticComplexity(file);

  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Cyclomatic Complexity of 831/);
});

test("complexity and codesize rules honor exact threshold boundaries", () => {
  const file = sourceFile(`
function one(value) { return value ? 1 : 0; }
function parameters(this: unknown, a, b) { return a + b; }
function lines() {
  const value = 1;
  return value;
}
class Small {
  value = 1;
  read() { return this.value; }
}
`);
  const body = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name.text === "one").body;
  const smallClass = file.statements.find((statement) => ts.isClassDeclaration(statement));
  assert.equal(calculateCyclomaticComplexity(body), 2);
  assert.equal(calculateNPathComplexity(body), 2);
  assert.equal(calculateClassLineCount(smallClass, file, false), 4);
  assert.equal(calculateClassComplexity(smallClass), 1);

  cyclomaticProperties.reportLevel = 2;
  assert.equal(findCyclomaticComplexity(file).length, 0);
  cyclomaticProperties.reportLevel = 1;
  assert.equal(findCyclomaticComplexity(file).length, 1);
  cyclomaticProperties.reportLevel = 10;

  npathProperties.minimum = 2;
  assert.equal(findNPathComplexity(file).length, 1);
  npathProperties.minimum = 200;

  parameterListProperties.minimum = 2;
  assert.equal(findExcessiveParameterList(file).length, 1);
  parameterListProperties.minimum = 10;

  methodLengthProperties.minimum = 4;
  assert.equal(findExcessiveMethodLength(file).length, 1);
  methodLengthProperties.minimum = 100;

  classLengthProperties.minimum = 4;
  assert.equal(findExcessiveClassLength(file).length, 1);
  classLengthProperties.minimum = 1000;

  fieldsProperties.maxfields = 0;
  assert.equal(findTooManyFields(file).length, 1);
  fieldsProperties.maxfields = 15;
  methodsProperties.maxmethods = 0;
  assert.equal(findTooManyMethods(file).length, 1);
  methodsProperties.maxmethods = 25;
  publicMethodsProperties.maxmethods = 0;
  assert.equal(findTooManyPublicMethods(file).length, 1);
  publicMethodsProperties.maxmethods = 10;
  publicCountProperties.minimum = 2;
  assert.equal(findExcessivePublicCount(file).length, 1);
  publicCountProperties.minimum = 45;
  classComplexityProperties.maximum = 1;
  assert.equal(findExcessiveClassComplexity(file).length, 1);
  classComplexityProperties.maximum = 50;
});

test("TooManyMethods and TooManyPublicMethods honor a configured ignorepattern and default to case-insensitive accessor prefixes", () => {
  const file = sourceFile(`
class Widget {
  fooBar() {}
  SETNAME() {}
}
`);

  // Default: uppercase "SETNAME" is excluded case-insensitively, leaving only
  // fooBar counted, so a max of 1 does not trip.
  methodsProperties.maxmethods = 1;
  assert.equal(findTooManyMethods(file).length, 0);
  publicMethodsProperties.maxmethods = 1;
  assert.equal(findTooManyPublicMethods(file).length, 0);

  // Configuring ignorepattern to exclude fooBar instead means SETNAME is now
  // counted (no longer excluded by the default), still 1 method <= max 1.
  methodsProperties.ignorepattern = "^fooBar$";
  assert.equal(findTooManyMethods(file).length, 0);
  publicMethodsProperties.ignorepattern = "^fooBar$";
  assert.equal(findTooManyPublicMethods(file).length, 0);

  // A configured pattern that matches nothing excludes nothing: both methods
  // are counted, tripping the max-1 threshold.
  methodsProperties.ignorepattern = "^nomatch$";
  assert.equal(findTooManyMethods(file).length, 1);
  publicMethodsProperties.ignorepattern = "^nomatch$";
  assert.equal(findTooManyPublicMethods(file).length, 1);

  methodsProperties.ignorepattern = "^(?:[sS][eE][tT]|[gG][eE][tT]|[iI][sS]|[hH][aA][sS]|[wW][iI][tT][hH])";
  publicMethodsProperties.ignorepattern = "^(?:[sS][eE][tT]|[gG][eE][tT]|[iI][sS]|[hH][aA][sS]|[wW][iI][tT][hH])";
  methodsProperties.maxmethods = 25;
  publicMethodsProperties.maxmethods = 10;

  const constructorFile = sourceFile(`
class OnlyConstructors {
  constructor();
  constructor(x: number);
  constructor(x?: number) {}
}
class WithBody {
  constructor(x: number);
  constructor(x: any) { this.x = x; }
}
class WithBodyAndMethods {
  constructor(x: number);
  constructor(x: any) { this.x = x; }
  trailing() {}
}
declare class AmbientConstructors {
  constructor(x: number);
  constructor(x: string);
}
`);
  // Constructor overloads are deduplicated down to 1 constructor
  assert.equal(getClassMethods(constructorFile.statements[0]).length, 1);
  assert.equal(getClassMethods(constructorFile.statements[1]).length, 1);
  assert.equal(getClassMethods(constructorFile.statements[2]).length, 2);
  assert.equal(getClassMethods(constructorFile.statements[3]).length, 1);
  methodsProperties.maxmethods = 2;
  assert.equal(findTooManyMethods(constructorFile).length, 0);
  publicMethodsProperties.maxmethods = 2;
  assert.equal(findTooManyPublicMethods(constructorFile).length, 0);

  const literalMethodFile = sourceFile(`
class Service {
  "getName"() { return "test"; }
  123() { return "num"; }
  \`templateName\`() { return "tpl"; }
}
`);
  // default ignorepattern matches ^get case-insensitively, so "getName" is ignored
  methodsProperties.maxmethods = 2;
  publicMethodsProperties.maxmethods = 2;
  assert.equal(findTooManyMethods(literalMethodFile).length, 0);
  assert.equal(findTooManyPublicMethods(literalMethodFile).length, 0);

  // explicitly match only exact get to confirm unquoted literal name is checked
  methodsProperties.ignorepattern = "^get$";
  publicMethodsProperties.ignorepattern = "^get$";
  methodsProperties.maxmethods = 0;
  publicMethodsProperties.maxmethods = 0;
  assert.equal(findTooManyMethods(literalMethodFile).length, 1);
  assert.equal(findTooManyPublicMethods(literalMethodFile).length, 1);

  const classExpression = sourceFile(`
export const ExpressionClass = class {
  method() { return 1; }
};
`);
  assert.match(messages(findTooManyMethods(classExpression))[0], /ExpressionClass/);
  assert.match(messages(findTooManyPublicMethods(classExpression))[0], /ExpressionClass/);
  methodsProperties.ignorepattern = "";
  publicMethodsProperties.ignorepattern = "";
  methodsProperties.maxmethods = 25;
  publicMethodsProperties.maxmethods = 10;
});

test("global, coupling, and cohesion rules track structural dependencies and state", () => {
  const file = sourceFile(`
import DefaultThing, { NamedThing as Alias } from "package";
import * as Namespace from "namespace";
import "side-effect";
export { value } from "re-export";
let mutable = 0;
const immutable = 1;
let array = [];
mutable += 1;
array.push(1);
class Service extends Base implements Contract {
  value = 0;
  right = 0;
  static state = 0;
  static readonly constant = 1;
  read() { return this.value; }
  write() { this.value += 1; }
  get alias() { return this.value; }
  set alias(value) { this.value = value; }
  rightRead() { return this.right; }
  static readState() { return this.state; }
  static writeState() { this.state += 1; }
  use() { return new Construct(Alias, Namespace.Value, DefaultThing); }
}
function use(value) { return require("runtime").run(value); }
`);
  const mutableFindings = findGlobalVariable([file]);
  assert.ok(messages(mutableFindings).some((message) => /mutable/ .test(message)));
  assert.ok(messages(mutableFindings).some((message) => /array/.test(message)));
  const immutableFindings = findGlobalVariable([file], true);
  assert.ok(immutableFindings.length > mutableFindings.length);
  assert.ok(immutableFindings.some((finding) => finding.context === "static field state"));

  const coupling = findCouplingBetweenObjects(file, 3);
  assert.ok(coupling.length >= 1);
  assert.ok(coupling.every((finding) => /coupling between objects value of/.test(finding.message)));

  const cohesionFile = sourceFile(`
class Cohesive {
  left = 0;
  right = 0;
  readLeft() { return this.left; }
  writeLeft() { this.left += 1; }
  readRight() { return this.right; }
  writeRight() { this.right += 1; }
  leftAlias() { return this.readLeft(); }
  get alias() { return this.left; }
  set alias(value) { this.left = value; }
}
`);
  const cohesionClass = cohesionFile.statements[0];
  assert.equal(calculateLcom4(cohesionClass), 2);
  assert.equal(findLackOfCohesionOfMethods(cohesionFile).length, 1);
  assert.equal(findLackOfCohesionOfMethods(cohesionFile, 2).length, 0);

  const staticCohesionFile = sourceFile(`
class OtherClass {
  static otherShared = 0;
  static otherMethod() { return 1; }
}
class StaticCohesion {
  static shared = 1;
  static helper() { return 2; }
  static methodA() {
    OtherClass.otherMethod();
    OtherClass.otherShared = 1;
    StaticCohesion.helper();
    return StaticCohesion.shared;
  }
  static methodB() { StaticCohesion.shared = 2; }
  instanceMethod() {
    StaticCohesion.shared = 3;
    return StaticCohesion.helper();
  }
}
`);
  assert.equal(calculateLcom4(staticCohesionFile.statements[1]), 1);
});

test("structural rules support JavaScript syntax and configured opt-ins", () => {
  const file = sourceFile(`
let state = 0;
const immutable = 1;
state += 1;
class JavaScriptService extends Base {
  left = 0;
  right = 0;
  readLeft() { return this.left; }
  writeLeft() { this.left += 1; }
  readRight() { return this.right; }
  writeRight() { this.right += 1; }
  use() { return new Dependency(); }
}
`, "structural.js");

  assert.equal(findGlobalVariable([file]).length, 1);
  globalProperties["report-immutable"] = true;
  assert.equal(findGlobalVariable([file]).length, 2);
  globalProperties["report-immutable"] = false;

  couplingProperties.maximum = 1;
  assert.equal(findCouplingBetweenObjects(file).length, 2);
  couplingProperties.maximum = 13;

  assert.equal(findLackOfCohesionOfMethods(file).length, 1);
  cohesionProperties.maximum = 2;
  assert.equal(findLackOfCohesionOfMethods(file).length, 0);
  cohesionProperties.maximum = 1;
});

test("global-variable reports mutated const module state", () => {
  const file = sourceFile(`
import importedValue from "external";
export const cache: number[] = [];
export let mutable = 0;
export const immutable = 1;
class StaticState {
  static readonly cache: number[] = [];
  static mutate() { this.cache.push(1); }
}
cache.push(1);
mutable += 1;
`);

  const findings = findGlobalVariable([file]);
  assert.deepEqual(findings.map((finding) => finding.context), [
    "global variable cache",
    "global variable mutable",
    "static field cache",
  ]);

  const immutableFindings = findGlobalVariable([file], true);
  assert.ok(messages(immutableFindings).some((message) => /immutable/.test(message)));
});

test("global-variable reports mutating methods through literal element access", () => {
  const file = sourceFile(`
export const cache: number[] = [];
export const untouched: number[] = [];
export function add(value: number, method: string) {
  cache["push"](value);
  untouched["map"](value);
  untouched[method](value);
}
`);

  assert.deepEqual(findGlobalVariable([file]).map((finding) => finding.context), [
    "global variable cache",
  ]);
});

test("exit-expression reports exit calls through literal element access", () => {
  const file = sourceFile(`
export function shutdown() {
  process["exit"](1);
}
export function halt() {
  process["abort"]();
}
export function stop() {
  Deno["exit"]();
}
export function dynamic(method: string) {
  process[method](1);
}
export function unrelated() {
  process["nextTick"](() => undefined);
}
`);

  assert.deepEqual(findExitExpression(file).map((finding) => finding.context), [
    "function shutdown()",
    "function halt()",
    "function stop()",
  ]);
});

test("static-access reports class calls through literal element access", () => {
  const file = sourceFile(`
export function run() {
  Logger["log"]("message");
}
export function template() {
  Logger[\`warn\`]("message");
}
export function dynamic(method: string) {
  Logger[method]("message");
}
export function lowercase() {
  logger["log"]("message");
}
class Own {
  run() {
    Own["log"]("message");
  }
}
`);

  assert.deepEqual(findStaticAccess(file).map((finding) => finding.context), [
    "function run()",
    "function template()",
  ]);
  assert.match(findStaticAccess(file)[0].message, /class 'Logger'/);
});

test("count-in-loop reports count properties through literal element access", () => {
  const file = sourceFile(`
export function run(items) {
  while (items["length"]) { break; }
}
export function template(items) {
  for (let index = 0; index < items[\`size\`]; index += 1) { work(index); }
}
export function called(items) {
  do { work(); } while (items["count"]());
}
export function dynamic(items, key) {
  while (items[key]) { break; }
}
export function unrelated(items) {
  while (items["ready"]) { break; }
}
`);

  const findings = findCountInLoopExpression(file);
  assert.deepEqual(findings.map((finding) => finding.message), [
    "Avoid using length in while loops.",
    "Avoid using size in for loops.",
    "Avoid using count in do loops.",
  ]);
});

test("coupling ignores the complete built-in type vocabulary", () => {
  const file = sourceFile(`
class BuiltinTypes {
  use(
    anyValue: any, bigintValue: bigint, booleanValue: boolean, neverValue: never,
    nullValue: null, numberValue: number, objectValue: object, stringValue: string,
    symbolValue: symbol, undefinedValue: undefined, unknownValue: unknown, voidValue: void,
    arrayValue: Array<number>, asyncIterableValue: AsyncIterable<number>, bigIntValue: BigInt,
    booleanObject: Boolean, dateValue: Date, errorValue: Error, functionValue: Function,
    iterableValue: Iterable<number>, iteratorValue: Iterator<number>, mapValue: Map<string, number>,
    mathValue: Math, numberObject: Number, objectObject: Object, promiseValue: Promise<number>,
    readonlyArrayValue: ReadonlyArray<number>, readonlyMapValue: ReadonlyMap<string, number>,
    readonlySetValue: ReadonlySet<number>, recordValue: Record<string, number>, regexpValue: RegExp,
    setValue: Set<number>, stringObject: String, symbolObject: Symbol, weakMapValue: WeakMap<object, object>,
    weakSetValue: WeakSet<object>, constructorParameters: ConstructorParameters<typeof BuiltinTypes>,
    excludeValue: Exclude<string, number>, extractValue: Extract<string, string>, instanceType: InstanceType<typeof BuiltinTypes>,
    nonNullableValue: NonNullable<string | null>, omitValue: Omit<object, "value">, partialValue: Partial<object>,
    parametersValue: Parameters<() => void>, pickValue: Pick<object, "value">, requiredValue: Required<object>,
    returnTypeValue: ReturnType<() => void>, thisParameterType: ThisParameterType<() => void>, thisTypeValue: ThisType<object>,
  ): void {}
}
`);

  assert.deepEqual(findCouplingBetweenObjects(file, 1), []);
});

test("coupling bills classes for syntax references, not file-level imports", () => {
  const imports = Array.from({ length: 13 }, (_, index) => `import { Unused${index} } from "./unused-${index}";`).join("\n");

  const untouchedFile = sourceFile(`${imports}
export class Untouched { x = 1; }
`);
  const untouchedFindings = findCouplingBetweenObjects(untouchedFile);
  assert.deepEqual(
    messages(untouchedFindings).filter((message) => /class Untouched/.test(message)),
    [],
  );
  assert.equal(untouchedFindings.length, 1);
  assert.match(untouchedFindings[0].message, /The module structural has a coupling between objects value of 13/);

  const lightlyCoupledFile = sourceFile(`${imports}
export class LightlyCoupled { first: Unused0; second = new Unused1(); }
`);
  assert.deepEqual(
    messages(findCouplingBetweenObjects(lightlyCoupledFile)).filter((message) => /class LightlyCoupled/.test(message)),
    [],
  );

  const heritageCoupledFile = sourceFile(`${imports}
@ClassDecorator()
export class HeavilyCoupled extends CoupledBase implements CoupledContract {
  field0: CoupledType0;
  field1: CoupledType1;
  field2: CoupledType2;
  field3: CoupledType3;
  field4: CoupledType4;
  field5: CoupledType5;
  field6: CoupledType6;
  field7: CoupledType7;
  field8: CoupledType8;
  field9: CoupledType9;
  helper = new CoupledHelper();
  run(value: CoupledValue): CoupledResult {
    return new CoupledBuilder();
  }
}
`);
  const heritageFindings = findCouplingBetweenObjects(heritageCoupledFile);
  assert.match(
    messages(heritageFindings).find((message) => /class HeavilyCoupled/.test(message)) ?? "",
    /coupling between objects value of 17/,
  );
});

test("coupling excludes builtin base names behind qualified and dotted references", () => {
  const builtinTails = ["bigint", "boolean", "never", "null", "number", "object", "string", "symbol", "undefined", "unknown", "void"];
  const tailsSource = builtinTails.map((name, index) => `  field${index}: Wrapper.${name};`).join("\n");
  assert.deepEqual(findCouplingBetweenObjects(sourceFile(`export class BuiltinTails {\n${tailsSource}\n}\n`), 1), []);

  const dottedBuiltinFile = sourceFile(`
export class DottedBuiltin { only: Outer.Inner.any; }
`);
  assert.deepEqual(findCouplingBetweenObjects(dottedBuiltinFile, 1), []);
});

test("coupling module pass counts imports, re-exports, requires, and external references", () => {
  const bareFile = sourceFile(`
import "side-a";
import "side-b";
export class Bare {}
`);
  const bareFindings = findCouplingBetweenObjects(bareFile, 1);
  assert.equal(bareFindings.length, 1);
  assert.match(bareFindings[0].message, /The module structural has a coupling between objects value of 2/);

  const clauseFile = sourceFile(`
import { Named } from "./named";
export class ClauseOnly {}
`);
  const clauseFindings = findCouplingBetweenObjects(clauseFile, 1);
  assert.equal(clauseFindings.length, 1);
  assert.match(clauseFindings[0].message, /value of 1/);

  const defaultFile = sourceFile(`
import DefaultThing from "./default";
`);
  assert.match(messages(findCouplingBetweenObjects(defaultFile, 1))[0] ?? "", /value of 1/);

  const namespaceFile = sourceFile(`
import * as Bundle from "./bundle";
`);
  assert.match(messages(findCouplingBetweenObjects(namespaceFile, 1))[0] ?? "", /value of 1/);

  const reExportFile = sourceFile(`
export { Alias as Renamed, Plain } from "./re-export";
`);
  assert.match(messages(findCouplingBetweenObjects(reExportFile, 1))[0] ?? "", /value of 2/);

  const requireFile = sourceFile(`
import "side";
export const delivered = require("./runtime");
export const reserve = require("./reserve");
export function other(value) { return helper("lit"); }
`);
  const requireFindings = findCouplingBetweenObjects(requireFile, 1);
  assert.equal(requireFindings.length, 1);
  assert.match(requireFindings[0].message, /value of 3/);

  const localFile = sourceFile(`
type LocalAlias = { value: string };
interface LocalInterface { run(): void; }
enum LocalEnum { Ready }
namespace LocalNamespace { export const item = 1; }
class LocalClass {}
const LocalExpr = class LocalExprName {}
export function use(a: LocalAlias, b: LocalInterface, c: LocalEnum, d: LocalNamespace, e: LocalClass, f: LocalExprName, g: ExternalValue): void {}
`);
  const localFindings = findCouplingBetweenObjects(localFile, 1);
  assert.equal(localFindings.length, 1);
  assert.match(localFindings[0].message, /value of 1/);
  assert.equal(localFindings[0].context, "module structural");
});

test("coupling counts query types, method parameters, require calls, and skips nested classes", () => {
  const typeQueryFile = sourceFile(`
export class TypeQuery { value: typeof ExternalValue; }
`);
  const typeQueryFindings = findCouplingBetweenObjects(typeQueryFile, 1);
  assert.equal(typeQueryFindings.length, 1);
  assert.match(typeQueryFindings[0].message, /class TypeQuery .*value of 1/);

  const requireClassFile = sourceFile(`
export class NeedsRuntime {
  load() { return require("./runtime"); }
  greet() { return helper("lit"); }
}
`);
  const requireClassFindings = findCouplingBetweenObjects(requireClassFile, 1);
  assert.deepEqual(
    messages(requireClassFindings).filter((message) => /class NeedsRuntime/.test(message)),
    ["The class NeedsRuntime has a coupling between objects value of 1. Consider to reduce the number of dependencies under 1."],
  );

  const parameterFile = sourceFile(`
export class Runner {
  run(value: ParamType = new ParamInit()): RetType {
    return new BodyType();
  }
}
`);
  const parameterFindings = findCouplingBetweenObjects(parameterFile, 1);
  assert.match(
    messages(parameterFindings).find((message) => /class Runner/.test(message)) ?? "",
    /value of 4/,
  );

  const nestedFile = sourceFile(`
export class Outer {
  factory() {
    return class Inner {
      field: InnerType;
      build() { return new InnerHelper(); }
    };
  }
}
`);
  const nestedFindings = findCouplingBetweenObjects(nestedFile, 1);
  assert.deepEqual(
    messages(nestedFindings).filter((message) => /class Outer/.test(message)),
    ["The class Outer has a coupling between objects value of 1. Consider to reduce the number of dependencies under 1."],
  );
});

test("coupling module findings report the basename without declaration or packaging extensions", () => {
  const template = `export class Named { value: ExternalValue; }\n`;
  const cases = [
    ["nested/deep/coupling.ts", "coupling"],
    ["types.d.js", "types"],
    ["lib.d.jsx", "lib"],
    ["types.d.mts", "types"],
    ["types.d.cts", "types"],
    ["value.js.ts", "value.js"],
    ["keep.d.ts.lock", "keep.d.ts.lock"],
  ];
  for (const [fileName, expected] of cases) {
    const findings = findCouplingBetweenObjects(sourceFile(template, fileName), 1);
    const moduleFinding = findings.find((finding) => finding.context === `module ${expected}`);
    assert.ok(moduleFinding, fileName);
    assert.ok(
      moduleFinding.message.includes(`The module ${expected} has a coupling between objects value of 1`),
      fileName,
    );
  }
});

test("global-variable analysis observes declaration and mutation forms", () => {
  const file = sourceFile(`
let scalar = 0;
let array = [];
let object = {};
let unassigned;
let [first, second] = array;
let { property } = object;
scalar = 1;
scalar += 1;
scalar -= 1;
scalar *= 1;
scalar /= 1;
scalar %= 1;
scalar **= 1;
scalar <<= 1;
scalar >>= 1;
scalar >>>= 1;
scalar &= 1;
scalar |= 1;
scalar ^= 1;
scalar ||= 1;
scalar &&= 1;
scalar ??= 1;
scalar++;
++scalar;
array.add(1); array.delete(1); array.fill(1); array.pop(); array.push(1); array.reverse();
array.set(1); array.shift(); array.sort(); array.splice(0); array.unshift(1);
Object.assign(object, {});
class StaticState {
  static mutable = 0;
  static readonly immutable = 0;
  static #privateValue = 0;
  static update() {
    this.mutable += 1;
    this.#privateValue++;
    StaticState.mutable++;
  }
}
`);
  const findings = findGlobalVariable([file]);
  const messagesFound = messages(findings);
  assert.ok(messagesFound.some((message) => /scalar/.test(message)));
  assert.ok(messagesFound.some((message) => /array/.test(message)));
  assert.ok(messagesFound.some((message) => /object/.test(message)));
  assert.ok(messagesFound.some((message) => /static mutable state: mutable/.test(message)));
  assert.ok(messagesFound.some((message) => /privateValue/.test(message)));

  const immutable = findGlobalVariable([file], true);
  assert.ok(immutable.length > findings.length);
  assert.ok(messages(immutable).some((message) => /unassigned/.test(message)));
  assert.ok(messages(immutable).some((message) => /first/.test(message)));
  assert.ok(messages(immutable).some((message) => /property/.test(message)));
});

test("global-variable matches literal static fields to element-access mutations", () => {
  const file = sourceFile(`
class LiteralState {
  static "count" = 0;
  static 0x10 = 0;
  static mutate() {
    this["count"] += 1;
    this[16] += 1;
  }
}
`);

  assert.deepEqual(findGlobalVariable([file]).map((finding) => finding.context), [
    "static field count",
    "static field 16",
  ]);
});

test("global-variable analysis observes mutations via destructuring assignments", () => {
  const file = sourceFile(`
let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0;
([a]) = [1];
[, b] = [0, 1];
[c = 10] = [];
[...d] = [1, 2];
({ key: e } = { key: 1 });
({ key: f = 10 } = {});
({ ...g } = { x: 1 });
({ h } = { h: 1 });
class Foo { static prop = 0; }
[Foo.prop] = [1];
`);
  const findings = findGlobalVariable([file], false);
  const found = messages(findings);
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "prop"]) {
    assert.ok(
      findings.some((f) => f.message.endsWith(`: ${name}.`)),
      `expected ${name} to be marked mutated`,
    );
  }
});

test("NPath counts the child of a labeled statement like the unlabeled form", () => {
  const labeled = sourceFile("function branch(value) { skip: if (value) { first(); } else { second(); } }");
  const unlabeled = sourceFile("function branch(value) { if (value) { first(); } else { second(); } }");
  const withStatement = sourceFile("function branch(value) { with (value) { if (value) { first(); } else { second(); } } }");

  assert.equal(calculateNPathComplexity(unlabeled.statements[0].body), 2);
  assert.equal(calculateNPathComplexity(labeled.statements[0].body), 2);
  assert.equal(calculateNPathComplexity(withStatement.statements[0].body), 2);

  npathProperties.minimum = 2;
  assert.equal(findNPathComplexity(labeled).length, 1);
  assert.equal(findNPathComplexity(unlabeled).length, 1);
  npathProperties.minimum = 200;
});

test("TooManyFields counts override constructor parameter properties as fields", () => {
  const previous = fieldsProperties.maxfields;
  fieldsProperties.maxfields = 0;
  try {
    assert.equal(findTooManyFields(sourceFile("class C { constructor(override x: number) {} }")).length, 1);
    assert.equal(findTooManyFields(sourceFile("class C { constructor(public x: number) {} }")).length, 1);
    assert.equal(findTooManyFields(sourceFile("class C { constructor(x: number) {} }")).length, 0);
    assert.equal(findTooManyFields(sourceFile("class C { constructor(override readonly x: number) {} }")).length, 1);
    assert.equal(findTooManyFields(sourceFile("class C { constructor(public override x: number) {} }")).length, 1);
    assert.equal(findTooManyFields(sourceFile("class C { constructor(private override x: number) {} }")).length, 1);
  } finally {
    fieldsProperties.maxfields = previous;
  }
});

test("NPath multiplies nested decisions inside a label and a label alone adds no path", () => {
  const nested = sourceFile(
    "function branch(value) { outer: if (value) { inner: if (value) { first(); } else { second(); } } else { third(); } }",
  );
  const labelOnly = sourceFile("function branch(value) { only: value(); }");

  assert.equal(calculateNPathComplexity(nested.statements[0].body), 3);
  assert.equal(calculateNPathComplexity(labelOnly.statements[0].body), 1);

  npathProperties.minimum = 200;
  assert.equal(findNPathComplexity(nested).length, 0);
  assert.equal(findNPathComplexity(labelOnly).length, 0);
});

test("IfStatementAssignment flags assignments in for and switch conditions and ignores initializers", () => {
  const code = `
function testConditions(n, y) {
  if (n = 1) {}
  while (n = 2) {}
  do {} while (n = 3);
  for (let i = 0; i = n; i++) {}
  for (; i = n;) {}
  for (let i = 0; i < n; i++) {}
  for (let i = 0; i < n; i = i + 1) {}
  for (;;) {}
  switch (n = y) {
    case (y = 1): break;
  }
}
`;
  const file = sourceFile(code);
  const findings = findIfStatementAssignment(file);

  assert.equal(findings.length, 6);
  assert.ok(findings.every((f) => f.ruleName === "IfStatementAssignment"));
  assert.ok(findings.every((f) => f.priority === 1));
  assert.ok(findings.every((f) => f.context === "function testConditions()"));
  assert.ok(messages(findings).every((message) => /Avoid assigning values to variables in if clauses and the like/.test(message)));
});
