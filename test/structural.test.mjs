import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
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
