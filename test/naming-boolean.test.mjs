import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import {
  collectBindings,
  collectBooleanReturns,
  collectParameters,
  collectProperties,
  getFunctionBindingName,
  getNameWithoutSigil,
  isReactComponentName,
} from "../dist/ast/names.js";
import { isBooleanExpression, isBooleanType } from "../dist/metrics/boolean.js";
import { findBooleanArgumentFlag, properties as booleanArgumentProperties } from "../dist/rules/boolean-argument-flag.js";
import { findBooleanGetMethodName, properties as booleanGetProperties } from "../dist/rules/boolean-get-method-name.js";
import { findCamelCaseClassName } from "../dist/rules/camel-case-class-name.js";
import { findCamelCaseMethodName } from "../dist/rules/camel-case-method-name.js";
import { findCamelCaseParameterName } from "../dist/rules/camel-case-parameter-name.js";
import { findCamelCasePropertyName } from "../dist/rules/camel-case-property-name.js";
import { findCamelCaseVariableName } from "../dist/rules/camel-case-variable-name.js";
import { isCamelCaseName, isPascalCaseName } from "../dist/rules/camel-case-utils.js";
import { findConstantNamingConventions } from "../dist/rules/constant-naming-conventions.js";
import { findLongClassName } from "../dist/rules/long-class-name.js";
import { findLongVariable } from "../dist/rules/long-variable.js";
import { isBooleanFunction, isConstantName, isIdiomaticShortName, adjustedLength } from "../dist/rules/naming-utils.js";
import { findShortClassName, properties as shortClassProperties } from "../dist/rules/short-class-name.js";
import { findShortMethodName } from "../dist/rules/short-method-name.js";
import { findShortVariable, properties as shortVariableProperties } from "../dist/rules/short-variable.js";

function sourceFile(source, fileName = "naming-boolean.ts") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function messages(findings) {
  return findings.map((finding) => finding.message);
}

function names(findings) {
  return findings.map((finding) => {
    const message = finding.message;
    return message.match(/boolean flag argument ([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1]
      ?? message.match(/'([A-Za-z_$][A-Za-z0-9_$]*)\(\)' method/)?.[1]
      ?? message.match(/(?:short|long) (?:method|variable|class) names like ([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1]
      ?? message.match(/short names like ([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1]
      ?? message.match(/(?:method|parameter|property|variable|class) ([A-Za-z_$][A-Za-z0-9_$]*) is not/)?.[1]
      ?? message.match(/Constant ([A-Za-z_$][A-Za-z0-9_$]*) should/)?.[1];
  }).filter(Boolean);
}

test("boolean types, expressions, and function return boundaries are precise", () => {
  const bool = sourceFile("let value: boolean | null | undefined;").statements[0].declarationList.declarations[0].type;
  const nonBool = sourceFile("let value: boolean | string;").statements[0].declarationList.declarations[0].type;
  assert.equal(isBooleanType(undefined), false);
  assert.equal(isBooleanType({ kind: ts.SyntaxKind.TrueKeyword }), true);
  assert.equal(isBooleanType({ kind: ts.SyntaxKind.FalseKeyword }), true);
  assert.equal(isBooleanType(bool), true);
  assert.equal(isBooleanType(nonBool), false);
  assert.equal(isBooleanType(sourceFile("let value: String;").statements[0].declarationList.declarations[0].type), false);
  assert.equal(isBooleanType(sourceFile("let value: boolean | null;").statements[0].declarationList.declarations[0].type), true);
  assert.equal(isBooleanType(sourceFile("let value: boolean | 1;").statements[0].declarationList.declarations[0].type), false);
  assert.equal(isBooleanType(sourceFile("let value: true;").statements[0].declarationList.declarations[0].type), false);
  assert.equal(isBooleanType(sourceFile("let value: Boolean;").statements[0].declarationList.declarations[0].type), true);
  assert.equal(isBooleanType(sourceFile("let value: (boolean);").statements[0].declarationList.declarations[0].type), true);

  const expression = (value) => sourceFile(`const result = ${value};`).statements[0].declarationList.declarations[0].initializer;
  for (const value of ["true", "false", "!value", "left === right", "left < right", "value in object", "value instanceof Type", "Boolean(value)"]) {
    assert.equal(isBooleanExpression(expression(value)), true, value);
  }
  assert.equal(isBooleanExpression(expression("value")), false);
  assert.equal(isBooleanExpression(expression("~value")), false);
  assert.equal(isBooleanExpression(expression("value ? true : false")), true);
  assert.equal(isBooleanExpression(expression("value ? true : 1")), false);
  assert.equal(isBooleanExpression(expression("NotBoolean(value)")), false);

  const booleanExpression = () => true;
  const booleanType = () => false;
  assert.equal(isBooleanFunction({ type: { kind: 0 }, body: undefined }, [], booleanExpression, () => true), true);
  assert.equal(isBooleanFunction({ type: undefined, body: undefined }, [], booleanExpression, booleanType), false);
  const complete = sourceFile("function complete() { return true; }").statements[0];
  const partial = sourceFile("function partial(value) { if (value) return true; }").statements[0];
  const both = sourceFile("function both(value) { if (value) return true; else return false; }").statements[0];
  const noReturn = sourceFile("function noReturn() { true; }").statements[0];
  const arrow = sourceFile("const arrow = () => true;").statements[0].declarationList.declarations[0].initializer;
  assert.equal(isBooleanFunction(complete, [expression("true")], booleanExpression, booleanType), true);
  assert.equal(isBooleanFunction(partial, [expression("true")], booleanExpression, booleanType), false);
  assert.equal(isBooleanFunction(both, [expression("true"), expression("false")], isBooleanExpression, isBooleanType), true);
  assert.equal(isBooleanFunction(noReturn, [expression("true")], booleanExpression, booleanType), false);
  assert.equal(isBooleanFunction(arrow, [expression("true")], booleanExpression, booleanType), true);
  assert.equal(isBooleanFunction(complete, [expression("true"), expression("value")], isBooleanExpression, isBooleanType), false);
});

test("boolean rules cover typed, inferred, destructured, parameterized, and non-boolean cases", () => {
  const file = sourceFile(`
export function booleanArguments(this: boolean, flag: boolean, boxed: Boolean, union: boolean | undefined, wrapped: (boolean), negated = !flag, off = false, bitwise = ~flag, text: String, count: number, number = 1) {}
export function destructured({ enabled = true, optional, count = 1, nested: { nestedEnabled = true } } = {}) {}
export function getFlag(): boolean { return true; }
export function getParameter(value: boolean): boolean { return value; }
export function getConditional(value: boolean): boolean { if (value) return true; return false; }
export function getPartial(value) { if (value) return true; }
export function getNumber(): number { return 1; }
export function isReady(): boolean { return true; }
class Service {
  getFlag(): boolean { return true; }
  private hidden(flag: boolean) {}
  [computed]() {}
}
`);
  const argumentFindings = findBooleanArgumentFlag(file).filter((finding) => /booleanArguments|destructured/.test(finding.context));
  assert.deepEqual(names(argumentFindings).sort(), ["boxed", "enabled", "flag", "negated", "nestedEnabled", "off", "union", "wrapped"]);
  assert.doesNotMatch(messages(argumentFindings).join("\n"), /optional|count|number|hidden/);
  assert.doesNotMatch(messages(argumentFindings).join("\n"), /this|bitwise|text/);

  const getFindings = findBooleanGetMethodName(file);
  assert.deepEqual(names(getFindings).sort(), ["getConditional", "getFlag", "getFlag", "getParameter"]);
  assert.doesNotMatch(messages(getFindings).join("\n"), /getNumber|getPartial|isReady/);
});

test("boolean rules honor visibility, exceptions, ignore patterns, computed names, and parameter configuration", () => {
  const file = sourceFile(`
class IgnoredService { publicFlag(flag: boolean) {} }
export function skipFlag(flag: boolean) {}
export function keptFlag(flag: boolean) {}
class ComputedService { [computed](flag: boolean) {} }
export function GetUpper(): boolean { return true; }
export function forgetFlag(): boolean { return true; }
`);

  booleanArgumentProperties.exceptions = " IgnoredService ";
  const excepted = findBooleanArgumentFlag(file);
  assert.equal(excepted.length, 3);
  assert.doesNotMatch(excepted.map((finding) => finding.context).join("\n"), /publicFlag/);
  booleanArgumentProperties.exceptions = "";
  booleanArgumentProperties.ignorepattern = "^skip";
  const patternIgnored = findBooleanArgumentFlag(file);
  assert.equal(patternIgnored.length, 3);
  assert.doesNotMatch(patternIgnored.map((finding) => finding.context).join("\n"), /skipFlag/);
  booleanArgumentProperties.ignorepattern = "^$";
  assert.doesNotMatch(messages(findBooleanArgumentFlag(file)).join("\n"), /ComputedService/);
  booleanArgumentProperties.ignorepattern = "";
  assert.deepEqual(findBooleanArgumentFlag(sourceFile("export const Anonymous = class { flagMethod(flag: boolean) {} };")), []);

  booleanGetProperties.checkParameterizedMethods = true;
  assert.deepEqual(names(findBooleanGetMethodName(sourceFile("function getFlag(value: boolean): boolean { return value; } function getNoParam(): boolean { return true; }"))), ["getNoParam"]);
  booleanGetProperties.checkParameterizedMethods = false;
  const getFindings = findBooleanGetMethodName(file);
  assert.deepEqual(names(getFindings), ["GetUpper"]);
  assert.doesNotMatch(messages(getFindings).join("\n"), /forgetFlag/);
});

test("casing rules distinguish roles, boundaries, constants, and computed names", () => {
  const file = sourceFile(`
export class bad_class {
  bad_property = 1;
  goodProperty = 2;
  bad_method(bad_parameter) { const bad_variable = 1; return bad_variable + bad_parameter; }
  goodMethod(goodParameter) { return goodParameter; }
  get bad_getter() { return true; }
  set bad_setter(value) {}
  [computed_method]() {}
}
export interface bad_interface { bad_method(bad_parameter: string): void; goodMethod(goodParameter: string): void; }
export function bad_function(bad_parameter) { const bad_local = 1; return bad_local + bad_parameter; }
export const bad_arrow = () => true;
export const bad_constant = 1;
export const GOOD_CONSTANT = 2;
export const goodValue = 3;
`);
  assert.equal(isCamelCaseName("_"), true);
  assert.equal(isCamelCaseName("$"), true);
  assert.equal(isCamelCaseName("#privateField"), true);
  assert.equal(isCamelCaseName("#bad_name"), false);
  assert.equal(isCamelCaseName("foo#Bar"), false);
  assert.equal(isCamelCaseName("foo2"), true);
  assert.equal(isCamelCaseName("bad_name"), false);
  assert.equal(isCamelCaseName("Foo"), false);
  assert.equal(isPascalCaseName("Foo2"), true);
  assert.equal(isPascalCaseName("#Foo2"), true);
  assert.equal(isPascalCaseName("#foo"), false);
  assert.equal(isPascalCaseName("Foo_"), false);
  assert.equal(isPascalCaseName("Foo#Bar"), false);
  assert.equal(isPascalCaseName("fooBar"), false);
  assert.equal(isPascalCaseName("foo"), false);

  assert.deepEqual(names(findCamelCaseClassName(file)).sort(), ["bad_class", "bad_interface"]);
  const camelMethods = findCamelCaseMethodName(file);
  assert.deepEqual(names(camelMethods).sort(), ["bad_function", "bad_getter", "bad_method", "bad_method", "bad_setter"]);
  assert.equal(camelMethods.filter((finding) => finding.context === "method bad_method()").length, 2);
  assert.deepEqual(names(findCamelCaseParameterName(file)).sort(), ["bad_parameter", "bad_parameter", "bad_parameter"]);
  assert.deepEqual(names(findCamelCasePropertyName(file)), ["bad_property"]);
  assert.deepEqual(names(findCamelCaseVariableName(file)).sort(), ["bad_local", "bad_variable"]);
  assert.deepEqual(names(findConstantNamingConventions(file)).sort(), ["bad_arrow", "bad_constant", "goodValue"]);
});

test("short and long naming rules honor idiomatic and threshold names", () => {
  const file = sourceFile(`
export class X {}
export class Ab {}
export class Foo {}
export class ThisIsAnExcessivelyLongClassNameThatNeedsRefactoring {}
export function a() {}
export function get() {}
export function i() {}
export function sufficientlyLong() {}
export const a = 1;
export const ab = 2;
export const abc = 3;
export const i = 4;
export const id = 5;
export const _private = 6;
export const thisIsAnExcessivelyLongVariableNameThatNeedsRefactoring = 7;
export const Component = () => true;
`);
  assert.deepEqual(names(findShortClassName(file)).sort(), ["Ab", "X"]);
  assert.deepEqual(names(findLongClassName(file)), ["ThisIsAnExcessivelyLongClassNameThatNeedsRefactoring"]);
  assert.deepEqual(names(findShortMethodName(file)).sort(), ["a"]);
  assert.deepEqual(names(findShortVariable(file)).sort(), ["a", "ab"]);
  assert.deepEqual(names(findLongVariable(file)), ["thisIsAnExcessivelyLongVariableNameThatNeedsRefactoring"]);
  assert.equal(adjustedLength("preValueSuffix", ["pre"], ["Suffix"]), 5);
  assert.equal(adjustedLength("#__value"), 5);
  assert.equal(adjustedLength("Stryker was here"), 16);
  assert.equal(adjustedLength("Stryker was here", ["Stryker was here"]), 0);
  assert.equal(adjustedLength("Stryker was here", [], ["Stryker was here"]), 0);
  for (const name of ["_", "$", "i", "j", "k", "x", "y", "z", "T", "K", "V", "U", "S", "dx", "dy", "dz", "id", "ok", "io", "cb", "fn", "e", "#x", "#id", "_ignored"]) {
    assert.equal(isIdiomaticShortName(name), true, name);
  }
  assert.equal(isIdiomaticShortName("value$"), false);
  assert.equal(isIdiomaticShortName("ab"), false);
  assert.equal(isConstantName("GOOD_CONSTANT_2"), true);
  assert.equal(isConstantName("bad_constant"), false);
  assert.equal(isConstantName("GOOD__CONSTANT"), false);
  shortClassProperties.exceptions = "Ab";
  assert.deepEqual(names(findShortClassName(file)).sort(), ["X"]);
  shortClassProperties.exceptions = "";
  shortVariableProperties.exceptions = "ab";
  assert.deepEqual(names(findShortVariable(file)).sort(), ["a"]);
  shortVariableProperties.exceptions = "";
});

test("naming boundaries and AST name roles remain observable", () => {
  const classAtLimit = `A${"b".repeat(39)}`;
  const classOverLimit = `${classAtLimit}b`;
  const variableAtLimit = `a${"b".repeat(19)}`;
  const variableOverLimit = `${variableAtLimit}b`;
  const file = sourceFile(`
class ${classAtLimit} {}
class ${classOverLimit} {}
const ${variableAtLimit} = 1;
const ${variableOverLimit} = 1;
class Fields {
  constructor(public readonly public_field: string, private private_field: string, protected protected_field: string, readonly readonly_field: string, plain_field: string) {}
  get bad_getter(): boolean { return true; }
  set bad_setter(value: boolean) {}
  [computed]() {}
}
interface Contract { bad_property: string; }
function namedFunction() {}
const NamedArrow = () => true;
const NamedFunction = function () { return true; };
const NamedClass = class {};
`);

  assert.deepEqual(findLongClassName(file).map((finding) => names([finding])[0]), [classOverLimit]);
  assert.deepEqual(findLongVariable(file).map((finding) => names([finding])[0]), [variableOverLimit]);
  assert.deepEqual(collectProperties(file).map((binding) => binding.name).filter((name) => name.endsWith("_field") || name === "bad_property").sort(), ["bad_property", "private_field", "protected_field", "public_field", "readonly_field"]);
  const bindings = collectBindings(file);
  assert.equal(bindings.filter((binding) => binding.name === "public_field").length, 1);
  assert.ok(collectParameters(file).some((binding) => binding.context === "parameter value"));
  assert.ok(collectProperties(file).some((binding) => binding.context === "field public_field"));
  assert.equal(getNameWithoutSigil("$#__value"), "value");
  assert.equal(getNameWithoutSigil("value$#__value"), "value$#__value");
  assert.equal(getFunctionBindingName(sourceFile("class C { constructor() {} }").statements[0].members[0], file), undefined);
  const fieldsClass = file.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name.text === "Fields");
  assert.equal(getFunctionBindingName(fieldsClass.members.find((member) => ts.isGetAccessorDeclaration(member)), file), "bad_getter");
  assert.equal(getFunctionBindingName(fieldsClass.members.find((member) => ts.isSetAccessorDeclaration(member)), file), "bad_setter");
  assert.equal(getFunctionBindingName(fieldsClass.members.find((member) => ts.isMethodDeclaration(member)), file), undefined);
  assert.equal(collectBooleanReturns(sourceFile("function outer() { return true; function inner() { return false; } }").statements[0].body).length, 1);

  const arrowNode = file.statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0].name.getText() === "NamedArrow").declarationList.declarations[0].initializer;
  const functionNode = file.statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0].name.getText() === "NamedFunction").declarationList.declarations[0].initializer;
  const classNode = file.statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0].name.getText() === "NamedClass").declarationList.declarations[0].initializer;
  const arrowIdentifier = file.statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0].name.getText() === "NamedArrow").declarationList.declarations[0].name;
  const nonComponentIdentifier = sourceFile("const NotComponent = 1;").statements[0].declarationList.declarations[0].name;
  const namedFunctionDeclaration = file.statements.find((statement) => ts.isFunctionDeclaration(statement));
  assert.equal(isReactComponentName("NamedArrow", arrowNode), true);
  assert.equal(isReactComponentName("NamedFunction", functionNode), true);
  assert.equal(isReactComponentName("NamedClass", classNode), true);
  assert.equal(isReactComponentName("plainFoo", arrowNode), false);
  assert.equal(isReactComponentName("NamedArrow", arrowIdentifier), true);
  assert.equal(isReactComponentName("NotComponent", nonComponentIdentifier), false);
  assert.equal(isReactComponentName("Named", file), false);
  assert.equal(isReactComponentName("NamedFunctionDeclaration", namedFunctionDeclaration), true);
});
