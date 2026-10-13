import ts from "typescript";
import { globalName } from "../ast/global-reference";
import * as expressions from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import * as library from "./library";

type Protocol = "iterate" | "convert" | "await";

const SCALAR_TYPES = new Set([
  ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.UndefinedKeyword, ts.SyntaxKind.NullKeyword,
]);
const ITERABLE_TYPES = new Set(["Array", "ReadonlyArray", "Map", "ReadonlyMap", "Set", "ReadonlySet", "String"]);

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

export function supportsProtocol(
  model: ScopeModel,
  expression: ts.Expression,
  protocol: Protocol,
  seen: ReadonlySet<Binding> = new Set(),
): boolean {
  const value = expressions.unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    return bindingSupports(model, value, protocol, seen);
  }
  const results = resultExpressions(value);
  if (results) {
    return results.every((result) => supportsProtocol(model, result, protocol, seen));
  }
  if (ts.isCallExpression(value)) {
    return callSupports(model, value, protocol, seen);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return protocol !== "convert";
  }
  if (ts.isNewExpression(value)) {
    return protocol === "iterate" && ITERABLE_TYPES.has(globalName(value.expression, model) ?? "");
  }
  return scalarSupports(value, protocol);
}

function resultExpressions(value: ts.Expression): readonly ts.Expression[] | undefined {
  if (ts.isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    if (assignments.isShortCircuit(operator)) {
      return [value.left, value.right];
    }
    if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
      return [value.right];
    }
  }
  return undefined;
}

function scalarSupports(value: ts.Expression, protocol: Protocol): boolean {
  if (protocol === "iterate") {
    return ts.isStringLiteralLike(value);
  }
  return ts.isLiteralExpression(value) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword || ts.isBinaryExpression(value) || ts.isPrefixUnaryExpression(value) || ts.isTemplateExpression(value);
}

function bindingSupports(model: ScopeModel, value: ts.Identifier, protocol: Protocol, seen: ReadonlySet<Binding>): boolean {
  const binding = model.resolve(value);
  if (!binding) {
    return protocol !== "iterate" && ["undefined", "NaN", "Infinity"].includes(value.text);
  }
  const parameters = binding.declarations.filter((declaration) => declaration.kind === "parameter");
  if (seen.has(binding)) {
    return parameters.length > 0 && parameters.every((declaration) => declarationSupports(model, declaration.node, protocol));
  }
  if (parameters.some((declaration) => !declarationSupports(model, declaration.node, protocol))) {
    return false;
  }
  const next = new Set(seen).add(binding);
  const assigned = assignments.bindingAssignments(binding);
  return assigned.length > 0 ? assigned.every((assignment) => assignment.value !== undefined &&
    supportsProtocol(model, assignment.value, protocol, next)) : parameters.length > 0;
}

function declarationSupports(model: ScopeModel, node: ts.Node, protocol: Protocol): boolean {
  return ts.isParameter(node) && node.type !== undefined && typeSupports(model, node.type, protocol);
}

function typeSupports(model: ScopeModel, type: ts.TypeNode, protocol: Protocol, seen: ReadonlySet<ts.TypeNode> = new Set()): boolean {
  if (seen.has(type)) {
    return false;
  }
  const next = new Set(seen).add(type);
  if (ts.isUnionTypeNode(type)) {
    return type.types.every((part) => typeSupports(model, part, protocol, next));
  }
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return typeSupports(model, type.type, protocol, next);
  }
  if (ts.isLiteralTypeNode(type)) {
    return protocol !== "iterate" || ts.isStringLiteralLike(type.literal);
  }
  if (protocol !== "iterate" && SCALAR_TYPES.has(type.kind)) {
    return true;
  }
  return containerTypeSupports(model, type, protocol, next);
}

function containerTypeSupports(model: ScopeModel, type: ts.TypeNode, protocol: Protocol, seen: ReadonlySet<ts.TypeNode>): boolean {
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) {
    return protocol !== "convert";
  }
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) {
    return protocol === "iterate" && type.kind === ts.SyntaxKind.StringKeyword;
  }
  return namedTypeSupports(model, type.typeName, protocol, seen);
}

function namedTypeSupports(model: ScopeModel, name: ts.Identifier, protocol: Protocol, seen: ReadonlySet<ts.TypeNode>): boolean {
  if (model.resolve(name)) {
    return false;
  }
  const local = model.resolveType(name);
  if (local) {
    return local.kind === "alias" && typeSupports(model, local.type, protocol, seen);
  }
  return protocol === "iterate" ? ITERABLE_TYPES.has(name.text) : protocol === "await" && name.text === "Promise";
}

function callSupports(model: ScopeModel, call: ts.CallExpression, protocol: Protocol, seen: ReadonlySet<Binding>): boolean {
  const name = globalName(call.expression, model);
  if (name?.startsWith("Promise.")) {
    return protocol === "await";
  }
  const known = library.libraryCall(call, model);
  if (known && known.kind !== "effect") {
    return protocol === "iterate" ? ["shallow", "holding", "mapped"].includes(known.result) : known.result === "fresh";
  }
  const callee = expressions.unwrapExpression(call.expression);
  return ts.isIdentifier(callee) && functionSupports(model, model.resolve(callee), protocol, seen);
}

function functionSupports(model: ScopeModel, binding: Binding | undefined, protocol: Protocol, seen: ReadonlySet<Binding>): boolean {
  if (!binding || seen.has(binding)) {
    return false;
  }
  const declarations = binding.declarations.filter((declaration) => ts.isFunctionDeclaration(declaration.node));
  return declarations.length > 0 && declarations.every((declaration) => {
    const node = declaration.node;
    if (!ts.isFunctionDeclaration(node)) {
      return false;
    }
    const async = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    return protocol === "await" && async === true || node.type !== undefined && typeSupports(model, node.type, protocol);
  });
}
