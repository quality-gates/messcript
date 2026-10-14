import ts from "typescript";
import * as expressions from "../ast/expressions";
import { globalName } from "../ast/global-reference";
import type { Binding, ScopeModel } from "../ast/scopes";
import { bindingAssignments } from "./assignments";

type StandardReceiver = "array" | "string" | "number" | "date" | "map" | "set" | "primitive";

const SCALAR_RECEIVER_TYPES = new Map<ts.SyntaxKind, StandardReceiver>([
  [ts.SyntaxKind.StringKeyword, "string"], [ts.SyntaxKind.NumberKeyword, "number"],
]);

const STANDARD_RECEIVER_TYPES = new Map<string, StandardReceiver>([
  ["Array", "array"], ["ReadonlyArray", "array"], ["String", "string"], ["Number", "number"],
  ["Date", "date"], ["Map", "map"], ["ReadonlyMap", "map"], ["WeakMap", "map"],
  ["Set", "set"], ["ReadonlySet", "set"], ["WeakSet", "set"], ["Boolean", "primitive"],
]);

const ARRAY_METHODS = new Set([
  "at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat",
  "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "reduce", "reduceRight",
  "slice", "some", "toReversed", "toSorted", "values",
]);

const STRING_METHODS = new Set([
  "at", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes", "indexOf", "lastIndexOf",
  "localeCompare", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "slice", "split",
  "startsWith", "substring", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toUpperCase", "trim",
  "trimEnd", "trimStart",
]);

export function standardMethod(model: ScopeModel, expression: ts.Expression, method: string | undefined): boolean {
  if (!method) {
    return false;
  }
  const receivers = standardReceivers(model, expression, new Set());
  return receivers.length > 0 && receivers.every((receiver) => receiverMethod(receiver, method));
}

export function standardReceiver(model: ScopeModel, expression: ts.Expression): boolean {
  return standardReceivers(model, expression, new Set()).length > 0;
}

function receiverMethod(receiver: StandardReceiver, method: string): boolean {
  if (method === "toString") {
    return true;
  }
  switch (receiver) {
    case "array": return ARRAY_METHODS.has(method);
    case "string": return STRING_METHODS.has(method);
    case "number": return method === "toFixed";
    case "date": return method === "getTime";
    case "map": return ["get", "has", "entries", "keys", "values", "forEach"].includes(method);
    case "set": return ["has", "entries", "keys", "values", "forEach"].includes(method);
    case "primitive": return false;
  }
}

function standardReceivers(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>): StandardReceiver[] {
  const value = expressions.unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    return bindingReceivers(model, value, seen);
  }
  if (ts.isNewExpression(value)) {
    const receiver = STANDARD_RECEIVER_TYPES.get(globalName(value.expression, model) ?? "");
    return receiver ? [receiver] : [];
  }
  if (ts.isCallExpression(value)) {
    return callReceivers(model, value.expression, seen);
  }
  if (ts.isConditionalExpression(value)) {
    return joinReceivers(standardReceivers(model, value.whenTrue, seen), standardReceivers(model, value.whenFalse, seen));
  }
  return literalReceivers(value);
}

function literalReceivers(value: ts.Expression): StandardReceiver[] {
  if (ts.isArrayLiteralExpression(value)) {
    return ["array"];
  }
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
    return ["string"];
  }
  if (ts.isNumericLiteral(value) || ts.isPrefixUnaryExpression(value)) {
    return ["number"];
  }
  return [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.BigIntLiteral].includes(value.kind) ? ["primitive"] : [];
}

function joinReceivers(left: StandardReceiver[], right: StandardReceiver[]): StandardReceiver[] {
  return left.length > 0 && right.length > 0 ? [...new Set([...left, ...right])] : [];
}

function bindingReceivers(model: ScopeModel, value: ts.Identifier, seen: ReadonlySet<Binding>): StandardReceiver[] {
  const binding = model.resolve(value);
  if (!binding) {
    return [];
  }
  if (seen.has(binding)) {
    const initial = binding.declarations.map((declaration) => declarationReceivers(model, declaration.node));
    return initial.every((part) => part.length > 0) ? [...new Set(initial.flat())] : [];
  }
  const next = new Set(seen).add(binding);
  const parameters = binding.declarations.filter((declaration) => declaration.kind === "parameter");
  const declared = parameters.map((declaration) => declarationReceivers(model, declaration.node));
  const assigned = bindingAssignments(binding).map((assignment) => assignment.value && !assignment.element
    ? standardReceivers(model, assignment.value, next) : []);
  const values = [...declared, ...assigned];
  return values.length > 0 && values.every((receivers) => receivers.length > 0) ? [...new Set(values.flat())] : [];
}

function declarationReceivers(model: ScopeModel, node: ts.Node): StandardReceiver[] {
  if (ts.isVariableDeclaration(node)) {
    return node.type ? typeReceivers(model, node.type) : node.initializer ? literalReceivers(expressions.unwrapExpression(node.initializer)) : [];
  }
  return (ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.type ? typeReceivers(model, node.type) : [];
}

function typeReceivers(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode> = new Set()): StandardReceiver[] {
  if (seen.has(type)) {
    return [];
  }
  const next = new Set(seen).add(type);
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return typeReceivers(model, type.type, next);
  }
  if (ts.isUnionTypeNode(type)) {
    const parts = type.types.map((part) => typeReceivers(model, part, next));
    return parts.every((part) => part.length > 0) ? [...new Set(parts.flat())] : [];
  }
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) {
    return ["array"];
  }
  return namedTypeReceivers(model, type, next);
}

function namedTypeReceivers(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode>): StandardReceiver[] {
  const scalar = SCALAR_RECEIVER_TYPES.get(type.kind);
  if (scalar) {
    return [scalar];
  }
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || model.resolve(type.typeName)) {
    return [];
  }
  const local = model.resolveType(type.typeName);
  if (local) {
    return local.kind === "alias" ? typeReceivers(model, local.type, seen) : [];
  }
  const receiver = STANDARD_RECEIVER_TYPES.get(type.typeName.text);
  return receiver ? [receiver] : [];
}

function callReceivers(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>): StandardReceiver[] {
  const name = globalName(expression, model);
  const global = globalCallReceiver(name);
  if (global) {
    return [global];
  }
  const callee = expressions.unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    const declared = model.resolve(callee)?.declarations.map((declaration) => declarationReceivers(model, declaration.node)) ?? [];
    return declared.length > 0 && declared.every((part) => part.length > 0) ? [...new Set(declared.flat())] : [];
  }
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
    ? memberReceivers(model, callee.expression, expressions.methodName(callee), seen) : [];
}

function globalCallReceiver(name: string | undefined): StandardReceiver | undefined {
  if (name === "String" || name === "JSON.stringify") {
    return "string";
  }
  if (name === "Number" || name?.startsWith("Math.")) {
    return "number";
  }
  return ["Array.from", "Array.of", "Object.keys", "Object.values", "Object.entries"].includes(name ?? "") ? "array" : undefined;
}

function memberReceivers(model: ScopeModel, receiver: ts.Expression, method: string | undefined, seen: ReadonlySet<Binding>): StandardReceiver[] {
  const receivers = standardReceivers(model, receiver, seen);
  if (!method || receivers.length === 0 || !receivers.every((receiver) => receiverMethod(receiver, method))) {
    return [];
  }
  if (["map", "flatMap", "filter", "flat", "toReversed", "toSorted", "split"].includes(method)) {
    return ["array"];
  }
  if (["slice", "concat"].includes(method)) {
    return receivers;
  }
  return method === "toString" || receivers.every((receiver) => receiver === "string") ? ["string"] : [];
}
