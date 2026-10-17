import ts from "typescript";
import { unwrapExpression } from "../ast/expressions";

function literalBooleanValue(expression: ts.Expression): boolean | undefined {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return undefined;
}

export function reachableChildren(node: ts.Node): readonly ts.Node[] | undefined {
  if (ts.isIfStatement(node)) {
    return conditionalChildren(node.expression, node.thenStatement, node.elseStatement);
  }
  if (ts.isWhileStatement(node) && literalBooleanValue(node.expression) === false) {
    return [node.expression];
  }
  if (ts.isForStatement(node) && node.condition && literalBooleanValue(node.condition) === false) {
    return [...(node.initializer ? [node.initializer] : []), node.condition];
  }
  return ts.isConditionalExpression(node) ? conditionalChildren(node.condition, node.whenTrue, node.whenFalse) : undefined;
}

function conditionalChildren(condition: ts.Expression, whenTrue: ts.Node, whenFalse: ts.Node | undefined): readonly ts.Node[] {
  const value = literalBooleanValue(condition);
  const selected = value === false ? [] : [whenTrue];
  return [condition, ...selected, ...(value !== true && whenFalse ? [whenFalse] : [])];
}

export function isReachable(node: ts.Node, owner: ts.Node): boolean {
  for (let current = node; current.parent && current !== owner; current = current.parent) {
    const children = reachableChildren(current.parent);
    if (children && !children.includes(current)) {
      return false;
    }
  }
  return true;
}
