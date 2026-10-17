import ts from "typescript";
import { globalName } from "../ast/global-reference";
import * as expressions from "../ast/expressions";
import type { ScopeModel } from "../ast/scopes";
import * as library from "./library";
import type { Protocol } from "./protocols";

/** A value an operation converts implicitly, with the members the conversion can run on it. */
export type ConvertedValue = { readonly expression: ts.Expression; readonly hooks: readonly string[] };

const PRIMITIVE_HOOKS = ["toString", "valueOf", "Symbol.toPrimitive"];
const CONVERTING_CALLS = new Set(["String", "Number", "BigInt", "parseInt", "parseFloat", "isNaN", "isFinite"]);
const CONVERTING_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.InKeyword,
]);
const CONVERTING_PREFIXES = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken]);

export function protocolExpressions(node: ts.Node, model: ScopeModel): readonly { expression: ts.Expression; protocol: Protocol }[] {
  if (ts.isForOfStatement(node) || ts.isSpreadElement(node)) {
    return [{ expression: node.expression, protocol: "iterate" }];
  }
  if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
    return [{ expression: node.expression, protocol: "iterate" }];
  }
  if (ts.isAwaitExpression(node)) {
    return [{ expression: node.expression, protocol: "await" }];
  }
  return [...conversionExpressions(node), ...constructorProtocols(node, model)];
}

function constructorProtocols(node: ts.Node, model: ScopeModel): readonly { expression: ts.Expression; protocol: Protocol }[] {
  if (ts.isCallExpression(node)) {
    const expression = library.iteratedArgument(node, model);
    return expression ? [{ expression, protocol: "iterate" }] : [];
  }
  if (ts.isNewExpression(node) && ["Map", "Set", "WeakMap", "WeakSet"].includes(globalName(node.expression, model) ?? "") && node.arguments?.[0]) {
    return [{ expression: node.arguments[0], protocol: "iterate" }];
  }
  return [];
}

function conversionExpressions(node: ts.Node): readonly { expression: ts.Expression; protocol: Protocol }[] {
  if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
    return node.templateSpans.map((span) => ({ expression: span.expression, protocol: "convert" }));
  }
  if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name) && node.initializer && ts.isArrayBindingPattern(node.name)) {
    return [{ expression: node.initializer, protocol: "iterate" }];
  }
  return [];
}

/** Gives the values the node converts implicitly, with the hooks the conversion can run on them. */
export function convertedValues(node: ts.Node, model: ScopeModel): readonly ConvertedValue[] {
  const operands = convertedOperands(node);
  if (operands) {
    return operands.map((expression) => ({ expression, hooks: PRIMITIVE_HOOKS }));
  }
  return ts.isCallExpression(node) && node.arguments[0] ? calledValues(node, node.arguments[0], model) : [];
}

/** Gives the operands an operator, a computed key, or an element key converts to a primitive. */
function convertedOperands(node: ts.Node): readonly ts.Expression[] | undefined {
  if (ts.isBinaryExpression(node) && CONVERTING_OPERATORS.has(node.operatorToken.kind)) {
    return node.operatorToken.kind === ts.SyntaxKind.InKeyword ? [node.left] : [node.left, node.right];
  }
  if (ts.isPrefixUnaryExpression(node) && CONVERTING_PREFIXES.has(node.operator)) {
    return [node.operand];
  }
  if (ts.isElementAccessExpression(node)) {
    return [node.argumentExpression];
  }
  return ts.isComputedPropertyName(node) ? [node.expression] : undefined;
}

/** Gives the values a global converting call, such as String(x) or JSON.stringify(x), converts. */
function calledValues(call: ts.CallExpression, argument: ts.Expression, model: ScopeModel): readonly ConvertedValue[] {
  const name = globalName(call.expression, model) ?? "";
  if (name === "JSON.stringify") {
    return serializedValues(argument).map((expression) => ({ expression, hooks: ["toJSON"] }));
  }
  return CONVERTING_CALLS.has(name) ? [{ expression: argument, hooks: PRIMITIVE_HOOKS }] : [];
}

/** Gives the value JSON serialization reads, with the values a literal written in place holds. */
function serializedValues(expression: ts.Expression): readonly ts.Expression[] {
  const value = expressions.unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(value)) {
    return [value, ...value.elements.flatMap((element) => serializedValues(ts.isSpreadElement(element) ? element.expression : element))];
  }
  return ts.isObjectLiteralExpression(value) ? [value, ...value.properties.flatMap(propertyValues)] : [value];
}

function propertyValues(property: ts.ObjectLiteralElementLike): readonly ts.Expression[] {
  if (ts.isPropertyAssignment(property)) {
    return serializedValues(property.initializer);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return [property.name];
  }
  return ts.isSpreadAssignment(property) ? [property.expression] : [];
}
