import assert from "node:assert/strict";
import ts from "typescript";
import { test } from "node:test";
import {
  forEachClass,
  getClassContext,
  getClassFields,
  getClassMethodName,
  getClassMethods,
  isIgnoredClassMethod,
  isPublicClassMember,
} from "../dist/ast/classes.js";
import {
  forEachFunction,
  forEachFunctionLike,
  getFunctionContext,
  getFunctionName,
  isFunctionLike,
} from "../dist/ast/functions.js";
import {
  collectBindings,
  collectBooleanReturns,
  collectParameters,
  collectProperties,
  collectSemanticConstants,
  collectVariables,
  forEachNamedType,
  getFunctionBindingName,
  getNameWithoutSigil,
  getNamedTypeContext,
  isReactComponentName,
} from "../dist/ast/names.js";
import { isBooleanExpression, isBooleanType } from "../dist/metrics/boolean.js";
import { calculateClassComplexity, calculateClassLineCount } from "../dist/metrics/classes.js";
import { calculateLcom4 } from "../dist/metrics/cohesion.js";
import { calculateNPathComplexity } from "../dist/metrics/complexity.js";
import { calculateCyclomaticComplexity } from "../dist/metrics/cyclomatic.js";
import { hasOptionalChain, isDecisionOperator } from "../dist/metrics/decisions.js";

function sourceFile(source, fileName = "fixture.ts") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function expression(source) {
  return sourceFile(`const value = ${source};`).statements[0].declarationList.declarations[0].initializer;
}

function names(bindings) {
  return bindings.map((binding) => `${binding.context}:${binding.name}`);
}

test("class and function visitors cover declarations, expressions, overloads, and contexts", () => {
  const file = sourceFile(`
class Named {
  public field = 1;
  #secret = 2;
  constructor(public parameter: string, private readonly hidden: number) {}
  get value() { return this.field; }
  set value(next: number) { this.field = next; }
  withValue() {}
  compute() { return this.field; }
  overloaded(value: string): void;
  overloaded(value: number): void;
  overloaded(value: string | number) {}
  orphan(value: string): void;
  different(value: number): void;
}
const Anonymous = class {};
function makeClass() { return class {}; }
function named(value: number) { return value; }
const arrow = (value: number) => value;
const expressionFunction = function expressionFunction() {};
`);
  const classes = [];
  forEachClass(file, (node) => classes.push(node));
  assert.deepEqual(classes.map((node) => getClassContext(node, file)), ["class Named", "class Anonymous", "class anonymous"]);

  const namedClass = classes[0];
  const methods = getClassMethods(namedClass);
  assert.deepEqual(methods.map((method) => getClassMethodName(method, file)), [
    "constructor",
    "value",
    "value",
    "withValue",
    "compute",
    "overloaded",
    "orphan",
    "different",
  ]);
  assert.deepEqual(getClassFields(namedClass).map((field) => field.name?.getText(file)), [
    "field",
    "#secret",
    "parameter",
    "hidden",
  ]);
  assert.equal(isPublicClassMember(getClassFields(namedClass)[0]), true);
  assert.equal(isPublicClassMember(getClassFields(namedClass)[1]), false);
  assert.equal(isPublicClassMember(getClassFields(namedClass)[3]), false);
  assert.equal(isPublicClassMember(methods[3]), true);
  assert.equal(isIgnoredClassMethod(methods[3], file), true);
  assert.equal(isIgnoredClassMethod(methods[4], file), false);

  const allFunctions = [];
  const functionsWithBodies = [];
  forEachFunctionLike(file, (node) => allFunctions.push(node));
  forEachFunction(file, (node) => functionsWithBodies.push(node));
  assert.equal(allFunctions.every((node) => isFunctionLike(node)), true);
  assert.equal(allFunctions.length, 14);
  assert.equal(functionsWithBodies.length, 10);
  assert.deepEqual(
    functionsWithBodies.map((node) => getFunctionContext(node, file)),
    [
      "constructor",
      "accessor value()",
      "accessor value()",
      "method withValue()",
      "method compute()",
      "method overloaded()",
      "function makeClass()",
      "function named()",
      "arrow function arrow()",
      "function expressionFunction()",
    ],
  );
  assert.equal(getFunctionName(functionsWithBodies.find((node) => ts.isFunctionDeclaration(node) && node.name.text === "named"), file), "named");
  assert.equal(getFunctionName(allFunctions.find((node) => ts.isArrowFunction(node)), file), "arrow");
  assert.equal(getFunctionContext(allFunctions.find((node) => ts.isArrowFunction(node)), file), "arrow function arrow()");
});

test("name collection covers bindings, signatures, types, constants, and React components", () => {
  const file = sourceFile(`
const top = 1;
let { first: alias, second } = values;
function named(parameter: string, { nested }: Input) { const local = parameter; return () => local; }
class Service<T> {
  static readonly constant = 1;
  field = 2;
  #private = 3;
  constructor(public parameter: string) {}
  method(methodParameter: number) { return methodParameter; }
  get named() { return this.field; }
  set named(value: number) { this.field = value; }
  [computed]() {}
}
interface Contract<T> { property: string; run(value: boolean): void; }
type Alias<T> = T;
const Component = () => true;
const plain = () => false;
const expression = function expression() {};
function Widget() {}
const ClassExpression = class {};
`);
  assert.deepEqual(names(collectVariables(file)), [
    "variable top:top",
    "variable { first: alias, second }:alias",
    "variable { first: alias, second }:second",
    "variable local:local",
    "variable Component:Component",
    "variable plain:plain",
    "variable expression:expression",
    "variable ClassExpression:ClassExpression",
  ]);
  assert.deepEqual(names(collectParameters(file)), [
    "parameter parameter:parameter",
    "parameter { nested }:nested",
    "parameter parameter:parameter",
    "parameter methodParameter:methodParameter",
    "parameter value:value",
    "parameter value:value",
  ]);
  assert.deepEqual(names(collectProperties(file)), [
    "field constant:constant",
    "field field:field",
    "field #private:#private",
    "field parameter:parameter",
    "property property:property",
  ]);
  assert.equal(collectBindings(file).some((binding) => binding.context === "type parameter T"), true);

  const namedTypes = [];
  forEachNamedType(file, (node, name) => namedTypes.push(`${getNamedTypeContext(node, file)}:${name}`));
  assert.deepEqual(namedTypes, [
    "class Service:Service",
    "interface Contract:Contract",
    "class ClassExpression:ClassExpression",
  ]);
  assert.deepEqual(names(collectSemanticConstants(file)), [
    "constant top:top",
    "constant constant:constant",
    "constant Component:Component",
    "constant plain:plain",
    "constant expression:expression",
    "constant ClassExpression:ClassExpression",
  ]);
  assert.equal(getNameWithoutSigil("$#__value"), "value");

  const functionNodes = [];
  forEachFunctionLike(file, (node) => functionNodes.push(node));
  const componentNode = functionNodes.find((node) => ts.isArrowFunction(node) && node.parent.name?.text === "Component");
  const plainNode = functionNodes.find((node) => ts.isArrowFunction(node) && node.parent.name?.text === "plain");
  assert.equal(isReactComponentName("Component", componentNode), true);
  assert.equal(isReactComponentName("plain", plainNode), false);
  assert.equal(isReactComponentName("Widget", file.statements.find((node) => ts.isFunctionDeclaration(node))), true);
  assert.equal(isReactComponentName("Service", file.statements.find((node) => ts.isClassDeclaration(node))), true);
  const classExpressionDeclaration = file.statements
    .find((node) => ts.isVariableStatement(node) && node.getText().includes("ClassExpression"))
    .declarationList.declarations[0];
  assert.equal(isReactComponentName("ClassExpression", classExpressionDeclaration), true);
  assert.equal(getFunctionBindingName(componentNode, file), "Component");
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isFunctionDeclaration(node)), file), "named");
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isConstructorDeclaration(node)), file), undefined);
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isMethodDeclaration(node)), file), "method");
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isGetAccessorDeclaration(node)), file), "named");
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isSetAccessorDeclaration(node)), file), "named");
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isMethodDeclaration(node) && ts.isComputedPropertyName(node.name)), file), undefined);
  assert.equal(getFunctionBindingName(functionNodes.find((node) => ts.isFunctionExpression(node)), file), "expression");

  const functionBody = file.statements.find((node) => ts.isFunctionDeclaration(node)).body;
  assert.equal(collectBooleanReturns(functionBody).length, 1);
  assert.equal(collectBooleanReturns(expression("true")).length, 1);
});

test("boolean metrics distinguish types, expressions, and conditional boundaries", () => {
  const bool = sourceFile("let value: boolean | null | undefined;").statements[0].declarationList.declarations[0].type;
  const union = sourceFile("let value: boolean | string;").statements[0].declarationList.declarations[0].type;
  assert.equal(isBooleanType(undefined), false);
  assert.equal(isBooleanType(bool), true);
  assert.equal(isBooleanType(union), false);
  assert.equal(isBooleanType(sourceFile("let value: Boolean;").statements[0].declarationList.declarations[0].type), true);
  assert.equal(isBooleanType(sourceFile("let value: (boolean);").statements[0].declarationList.declarations[0].type), true);

  for (const value of ["true", "false", "!value", "left === right", "left < right", '"value" in object', "value instanceof Type", "Boolean(value)", "value as boolean"]) {
    assert.equal(isBooleanExpression(expression(value)), true, value);
  }
  assert.equal(isBooleanExpression(expression("value")), false);
  assert.equal(isBooleanExpression(expression("value ? true : false")), true);
  assert.equal(isBooleanExpression(expression("value ? true : 1")), false);
});

test("decision and complexity metrics cover optional chains, operators, and statement boundaries", () => {
  assert.equal(hasOptionalChain(expression("value?.next")), true);
  assert.equal(hasOptionalChain(expression("value?.[key]")), true);
  assert.equal(hasOptionalChain(expression("value?.()")), true);
  assert.equal(hasOptionalChain(expression("value.next")), false);
  assert.equal(hasOptionalChain(expression("value")), false);
  assert.equal(isDecisionOperator(ts.SyntaxKind.AmpersandAmpersandToken), true);
  assert.equal(isDecisionOperator(ts.SyntaxKind.BarBarToken), true);
  assert.equal(isDecisionOperator(ts.SyntaxKind.QuestionQuestionToken), true);
  assert.equal(isDecisionOperator(ts.SyntaxKind.PlusToken), false);

  const file = sourceFile(`
function decisions(value) {
  if (value && value.next?.()) return value ? 1 : 0;
  for (let index = 0; index < value; index += 1) value += index;
  switch (value) { case 1: return 1; default: return 0; }
}
`);
  const body = file.statements[0].body;
  assert.equal(calculateCyclomaticComplexity(body), 7);
  assert.equal(calculateNPathComplexity(body), 20);
  assert.equal(calculateNPathComplexity(expression("value ? 1 : 0")), 2);
});

test("class metrics cover whitespace, complexity, empty classes, and cohesion boundaries", () => {
  const file = sourceFile(`class Service {

  value = 0;

  read() {
    if (this.value) return 1;
    return 0;
  }
}
`);
  const node = file.statements[0];
  assert.equal(calculateClassLineCount(node, file, false), 9);
  assert.equal(calculateClassLineCount(node, file, true), 7);
  assert.equal(calculateClassComplexity(node), 2);
  assert.equal(calculateLcom4(sourceFile("class Empty {}").statements[0]), 1);
  assert.equal(calculateLcom4(sourceFile("class Stateless { one() {} two() {} }").statements[0]), 1);
});
