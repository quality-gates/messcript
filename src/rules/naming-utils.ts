import ts from "typescript";
import type { NamedBinding } from "../ast/names";
import { getNameWithoutSigil, isReactComponentName } from "../ast/names";

export const shortNameExceptions = new Set([
  "T", "K", "V", "U", "S", "i", "j", "k", "x", "y", "z", "dx", "dy", "dz", "id", "ok", "io", "cb", "fn", "e", "$",
]);

export function isIdiomaticShortName(name: string): boolean {
  const normalized = getNameWithoutSigil(name);
  return name.startsWith("_") || name.startsWith("$") || shortNameExceptions.has(name) || shortNameExceptions.has(normalized);
}

export function isReactComponentBinding(binding: NamedBinding): boolean {
  return isReactComponentName(binding.name, binding.node);
}

export function adjustedLength(name: string, prefixes: readonly string[] = [], suffixes: readonly string[] = []): number {
  let adjusted = getNameWithoutSigil(name);
  const prefix = prefixes.find((candidate) => adjusted.startsWith(candidate));
  if (prefix) {
    adjusted = adjusted.slice(prefix.length);
  }
  const suffix = suffixes.find((candidate) => adjusted.endsWith(candidate));
  if (suffix) {
    adjusted = adjusted.slice(0, -suffix.length);
  }
  return adjusted.length;
}

export function isConstantName(name: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name);
}

function definitelyReturns(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && definitelyReturns(last);
  }
  if (ts.isIfStatement(statement)) {
    return statement.elseStatement !== undefined && definitelyReturns(statement.thenStatement) && definitelyReturns(statement.elseStatement);
  }
  return false;
}

export function isBooleanFunction(
  node: ts.Node & { body?: ts.ConciseBody; type?: ts.TypeNode },
  returns: readonly ts.Expression[],
  isBooleanExpression: (expression: ts.Expression) => boolean,
  isBooleanType: (type: ts.TypeNode | undefined) => boolean,
): boolean {
  if (isBooleanType(node.type)) {
    return true;
  }
  if (returns.length === 0 || !returns.every((expression) => isBooleanExpression(expression))) {
    return false;
  }
  return !node.body || !ts.isBlock(node.body) || definitelyReturns(node.body);
}
