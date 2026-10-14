// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { isLocallyBound } from "./local-bindings";
import type { Binding, ScopeModel } from "./scopes";

// Names of the global object. A global is also reached through them, as in globalThis.process.
const globalObjectNames = new Set(["globalThis", "self", "window"]);

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isMemberAccess(node: ts.Node): node is MemberAccess {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function memberKey(node: MemberAccess): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const argument = unwrapExpression(node.argumentExpression);
  return ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function isGlobalObject(node: ts.Expression): boolean {
  return globalObjectNames.has(globalReference(node) ?? "");
}

function dottedName(node: ts.Expression, resolvesRoot: boolean): string | undefined {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return resolvesRoot && isLocallyBound(expression) ? undefined : expression.text;
  }
  if (!isMemberAccess(expression)) {
    return undefined;
  }
  const key = memberKey(expression);
  if (key === undefined || isGlobalObject(expression.expression)) {
    return key;
  }
  const receiver = dottedName(expression.expression, resolvesRoot);
  return receiver === undefined ? undefined : `${receiver}.${key}`;
}

/**
 * Gives the literal key of a member access on the global object, as "alert" for window.alert.
 * Gives undefined when the receiver is not the global object or is locally bound.
 */
export function globalObjectMember(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  return isMemberAccess(expression) && isGlobalObject(expression.expression) ? memberKey(expression) : undefined;
}

/**
 * Gives the dotted name of the host global that the expression refers to, as in "process.exit".
 * Access through the global object is removed, so globalThis.process.exit and window["process"].exit give "process.exit".
 * Gives undefined when the root identifier is locally bound, when a key is not a literal, or when the root is not an identifier.
 */
export function globalReference(node: ts.Expression): string | undefined {
  return dottedName(node, true);
}

/**
 * Gives the dotted name of the expression, as globalReference does, but also when the root identifier is locally bound.
 * Use it for names that are not host globals, as in a local logger.trace.
 */
export function memberChainName(node: ts.Expression): string | undefined {
  return dottedName(node, false);
}

/**
 * Gives the name of the unbound identifier that the identifier reaches through constant aliases, as console for out in const out = console.
 * Gives undefined when a binding on the way is not a constant initialized with an identifier.
 */
export function aliasedGlobal(identifier: ts.Identifier, model: ScopeModel, seen: ReadonlySet<Binding> = new Set()): string | undefined {
  const binding = model.resolve(identifier);
  if (!binding) {
    return identifier.text;
  }
  const value = seen.has(binding) ? undefined : constantInitializer(binding);
  return value && ts.isIdentifier(value) ? aliasedGlobal(value, model, new Set(seen).add(binding)) : undefined;
}

function constantInitializer(binding: Binding): ts.Expression | undefined {
  const declaration = binding.declarations.length === 1 ? binding.declarations[0].node : undefined;
  const constant = !!declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  return constant && declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
}

/** Gives the dotted global name of the callee, or undefined when its root is bound in the file to anything but a constant alias of a global. */
export function globalName(callee: ts.Expression, model: ScopeModel): string | undefined {
  let root = unwrapExpression(callee);
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
    root = unwrapExpression(root.expression);
  }
  if (!ts.isIdentifier(root) || !model.resolve(root)) {
    return globalReference(callee);
  }
  const global = aliasedGlobal(root, model);
  const chain = memberChainName(callee);
  return global === undefined || chain === undefined ? undefined : global + chain.slice(root.text.length);
}
