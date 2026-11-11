// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { isLocallyBound } from "./local-bindings";

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
  const reference = globalReference(node);
  return reference !== undefined && globalObjectNames.has(reference);
}

function dottedName(node: ts.Expression, resolvesRoot: boolean): string | undefined {
  let current = unwrapExpression(node);
  const keys: string[] = [];
  while (isMemberAccess(current)) {
    const key = memberKey(current);
    if (key === undefined) {
      return undefined;
    }
    keys.push(key);
    current = unwrapExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) {
    return undefined;
  }
  const rootBound = isLocallyBound(current);
  if (resolvesRoot && rootBound) {
    return undefined;
  }
  if (keys.length === 0) {
    return current.text;
  }
  keys.reverse();
  let isGlobal = !rootBound && globalObjectNames.has(current.text);
  let result: string | undefined = isGlobal ? undefined : current.text;
  for (const key of keys) {
    if (isGlobal) {
      result = key;
      isGlobal = globalObjectNames.has(key);
    } else {
      result = `${result}.${key}`;
    }
  }
  return result;
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
