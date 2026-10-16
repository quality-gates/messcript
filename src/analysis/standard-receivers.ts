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
  const receiver = expressions.unwrapExpression(expression);
  if (!method || ((ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) && model.writesMemberName(method))) {
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

function standardReceivers(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>, path: readonly string[] = []): StandardReceiver[] {
  const value = expressions.unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    return bindingReceivers(model, value, seen, path);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const name = expressions.methodName(value);
    return name === undefined || model.writesMemberName(name) ? [] : standardReceivers(model, value.expression, seen, [name, ...path]);
  }
  return evaluatedReceivers(model, value, seen, path);
}

function evaluatedReceivers(model: ScopeModel, value: ts.Expression, seen: ReadonlySet<Binding>, path: readonly string[]): StandardReceiver[] {
  if (ts.isConditionalExpression(value)) {
    return joinReceivers(standardReceivers(model, value.whenTrue, seen, path), standardReceivers(model, value.whenFalse, seen, path));
  }
  if (path.length > 0) {
    return literalMemberReceivers(model, value, seen, path);
  }
  if (ts.isNewExpression(value)) {
    const receiver = STANDARD_RECEIVER_TYPES.get(globalName(value.expression, model) ?? "");
    return receiver ? [receiver] : [];
  }
  return ts.isCallExpression(value) ? callReceivers(model, value.expression, seen) : literalReceivers(value);
}

function literalMemberReceivers(model: ScopeModel, value: ts.Expression, seen: ReadonlySet<Binding>, path: readonly string[]): StandardReceiver[] {
  const [name, ...rest] = path;
  if (!ts.isObjectLiteralExpression(value) || value.properties.some(ts.isSpreadAssignment)) {
    return [];
  }
  const property = [...value.properties].reverse().find((item) => item.name && memberKey(item.name) === name);
  if (property && ts.isPropertyAssignment(property)) {
    return standardReceivers(model, property.initializer, seen, rest);
  }
  return property && ts.isShorthandPropertyAssignment(property) ? standardReceivers(model, property.name, seen, rest) : [];
}

function memberKey(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    const key = expressions.unwrapExpression(name.expression);
    return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  }
  return ts.isPrivateIdentifier(name) ? undefined : name.text;
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

function bindingReceivers(model: ScopeModel, value: ts.Identifier, seen: ReadonlySet<Binding>, path: readonly string[]): StandardReceiver[] {
  const binding = model.resolve(value);
  if (!binding) {
    return [];
  }
  if (seen.has(binding)) {
    const initial = binding.declarations.map((declaration) => declarationReceivers(model, declaration.node, path));
    return initial.every((part) => part.length > 0) ? [...new Set(initial.flat())] : [];
  }
  const next = new Set(seen).add(binding);
  const parameters = binding.declarations.filter((declaration) => declaration.kind === "parameter");
  const declared = [...parameters, ...binding.declarations.filter((declaration) => ts.isClassDeclaration(declaration.node))]
    .map((declaration) => declarationReceivers(model, declaration.node, path));
  const assigned = bindingAssignments(binding).map((assignment) => assignment.value && !assignment.element
    ? standardReceivers(model, assignment.value, next, path) : []);
  const values = [...declared, ...assigned];
  return values.length > 0 && values.every((receivers) => receivers.length > 0) ? [...new Set(values.flat())] : [];
}

function declarationReceivers(model: ScopeModel, node: ts.Node, path: readonly string[] = []): StandardReceiver[] {
  if (ts.isVariableDeclaration(node)) {
    if (node.type) {
      return typeReceivers(model, node.type, new Set(), path);
    }
    if (!node.initializer) {
      return [];
    }
    const value = expressions.unwrapExpression(node.initializer);
    return path.length > 0 ? literalMemberReceivers(model, value, new Set(), path) : literalReceivers(value);
  }
  if (ts.isClassDeclaration(node)) {
    return staticMemberReceivers(model, node, path);
  }
  return (ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.type ? typeReceivers(model, node.type, new Set(), path) : [];
}

/** Gives the receivers of a static field a class declares, when no decorator may replace the class or the field. */
function staticMemberReceivers(model: ScopeModel, node: ts.ClassDeclaration, path: readonly string[]): StandardReceiver[] {
  const [name, ...rest] = path;
  const members = node.members.filter((member) => member.name && memberKey(member.name) === name &&
    ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword));
  const [member] = members;
  if (name === undefined || members.length !== 1 || !ts.isPropertyDeclaration(member) || ts.getDecorators(node) || ts.getDecorators(member)) {
    return [];
  }
  if (member.type) {
    return typeReceivers(model, member.type, new Set(), rest);
  }
  if (!member.initializer) {
    return [];
  }
  const value = expressions.unwrapExpression(member.initializer);
  return rest.length > 0 ? literalMemberReceivers(model, value, new Set(), rest) : literalReceivers(value);
}

function typeReceivers(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode> = new Set(), path: readonly string[] = []): StandardReceiver[] {
  if (seen.has(type)) {
    return [];
  }
  const next = new Set(seen).add(type);
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return typeReceivers(model, type.type, next, path);
  }
  if (ts.isUnionTypeNode(type)) {
    const parts = type.types.map((part) => typeReceivers(model, part, next, path));
    return parts.every((part) => part.length > 0) ? [...new Set(parts.flat())] : [];
  }
  return projectedTypeReceivers(model, type, next, path);
}

function projectedTypeReceivers(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode>, path: readonly string[]): StandardReceiver[] {
  if (path.length === 0) {
    return unprojectedTypeReceivers(model, type, seen);
  }
  if (!ts.isTypeLiteralNode(type)) {
    return namedTypeReceivers(model, type, seen, path);
  }
  const [name, ...rest] = path;
  const member = type.members.find((item) => item.name && memberKey(item.name) === name);
  return member && ts.isPropertySignature(member) && member.type && !member.questionToken
    ? typeReceivers(model, member.type, seen, rest) : [];
}

function unprojectedTypeReceivers(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode>): StandardReceiver[] {
  const scalar = SCALAR_RECEIVER_TYPES.get(type.kind);
  if (scalar) { return [scalar]; }
  return ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type) ? ["array"] : namedTypeReceivers(model, type, seen, []);
}

function namedTypeReceivers(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode>, path: readonly string[]): StandardReceiver[] {
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || model.resolve(type.typeName)) {
    return [];
  }
  const local = model.resolveType(type.typeName);
  if (local) {
    return local.kind === "alias" ? typeReceivers(model, local.type, seen, path) : [];
  }
  if (path.length > 0) { return []; }
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
    const binding = model.resolve(callee);
    const inferred = binding && !seen.has(binding) && bindingAssignments(binding).length === 0;
    const declared = binding?.declarations.map((declaration) => {
      const typed = declarationReceivers(model, declaration.node);
      return typed.length > 0 || !inferred ? typed : returnedReceivers(model, declaration.node, new Set(seen).add(binding));
    }) ?? [];
    return declared.length > 0 && declared.every((part) => part.length > 0) ? [...new Set(declared.flat())] : [];
  }
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
    ? memberReceivers(model, callee.expression, expressions.methodName(callee), seen) : [];
}

/** Gives the receivers every return of a plain function declaration gives, when it declares no return type. */
function returnedReceivers(model: ScopeModel, node: ts.Node, seen: ReadonlySet<Binding>): StandardReceiver[] {
  if (!ts.isFunctionDeclaration(node) || !node.body || node.type || node.asteriskToken ||
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    return [];
  }
  const returned: (ts.Expression | undefined)[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isReturnStatement(child)) {
      returned.push(child.expression);
    } else if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) {
      ts.forEachChild(child, visit);
    }
  };
  ts.forEachChild(node.body, visit);
  const parts = returned.map((value) => value ? standardReceivers(model, value, seen) : []);
  return parts.length > 0 && parts.every((part) => part.length > 0) ? [...new Set(parts.flat())] : [];
}

/** Tells if the method returns its receiver, as Map's set and Set's add do. */
function returnsReceiver(receiver: StandardReceiver, method: string): boolean {
  return (receiver === "map" && method === "set") || (receiver === "set" && method === "add");
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
  if (!method || receivers.length === 0 || model.writesMemberName(method) ||
      !receivers.every((receiver) => receiverMethod(receiver, method) || returnsReceiver(receiver, method))) {
    return [];
  }
  if (["map", "flatMap", "filter", "flat", "toReversed", "toSorted", "split"].includes(method)) {
    return ["array"];
  }
  if (["slice", "concat"].includes(method) || receivers.every((receiver) => returnsReceiver(receiver, method))) {
    return receivers;
  }
  return method === "toString" || receivers.every((receiver) => receiver === "string") ? ["string"] : [];
}
