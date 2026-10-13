import ts from "typescript";
import { isFunctionLike } from "../ast/functions";
import { outerExpression } from "../ast/expressions";
import type { Binding } from "../ast/scopes";
import type { EffectOwner } from "./owners";

/**
 * A value that a binding can receive.
 * A missing value is a value this analysis does not trace. An element value holds a part of the value.
 * A joined value can reach a site together with earlier values.
 */
export type Assignment = {
  readonly node: ts.Node;
  readonly value?: ts.Expression;
  readonly element?: boolean;
  readonly join?: boolean;
};

/** Gives every value the binding can receive anywhere in the file, in source order. */
export function bindingAssignments(binding: Binding): Assignment[] {
  const assignments: Assignment[] = [];
  for (const item of binding.declarations) {
    const declared = declarationAssignment(item.node, item.identifier);
    if (declared) {
      assignments.push(declared);
    }
  }
  for (const reference of binding.references) {
    const assignment = referenceAssignment(reference);
    if (assignment) {
      assignments.push(assignment);
    }
  }
  return assignments.sort((left, right) => left.node.pos - right.node.pos);
}

/** Gives the values of the binding that can reach the site in the owner, in source order. A joined value does not replace earlier values. */
export function assignmentsBeforeSite(binding: Binding, owner: EffectOwner, site: ts.Node): Assignment[] {
  return bindingAssignments(binding)
    .filter((assignment) => inside(assignment.node, owner))
    .flatMap((assignment) => reaching(assignment, owner, site));
}

function reaching(assignment: Assignment, owner: EffectOwner, site: ts.Node): Assignment[] {
  if (deferred(assignment.node, owner) || repeated(assignment, owner, site)) {
    return [{ ...assignment, join: true }];
  }
  if (assignment.node.end > site.getStart()) {
    return [];
  }
  return [unconditional(assignment.node, owner) ? assignment : { ...assignment, join: true }];
}

function repeated(assignment: Assignment, owner: EffectOwner, site: ts.Node): boolean {
  for (let current: ts.Node | undefined = site.parent; current && current !== owner; current = current.parent) {
    if (ts.isIterationStatement(current, false) && inside(assignment.node, current)) {
      return assignment.node.end > site.getStart() || !unconditional(assignment.node, owner);
    }
  }
  return false;
}

function deferred(node: ts.Node, owner: EffectOwner): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (isFunctionLike(current)) {
      return true;
    }
  }
  return false;
}

function declarationAssignment(node: ts.Node, identifier: ts.Identifier): Assignment | undefined {
  if (!ts.isVariableDeclaration(node)) {
    return undefined;
  }
  if (ts.isCatchClause(node.parent)) {
    return { node, join: true };
  }
  const loop = node.parent.parent;
  if (ts.isForOfStatement(loop) && loop.initializer === node.parent) {
    return { node: loop.statement, value: loop.expression, element: true, join: true };
  }
  if (!node.initializer || ts.isForInStatement(loop)) {
    return undefined;
  }
  return { node, value: node.initializer, element: node.name !== identifier };
}

function referenceAssignment(reference: ts.Identifier): Assignment | undefined {
  const target = outerExpression(reference);
  const parent = target.parent;
  if (ts.isBinaryExpression(parent) && parent.left === target) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.EqualsToken) {
      return { node: parent, value: parent.right };
    }
    return isLogicalAssignment(operator) ? { node: parent, value: parent.right, join: true } : undefined;
  }
  return patternOrLoopTarget(target) ? { node: target, join: true } : undefined;
}

function isLogicalAssignment(operator: number): boolean {
  return operator === ts.SyntaxKind.QuestionQuestionEqualsToken || operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
}

/** Tells if the operator gives one of its operands, as || and ?? do. */
export function isShortCircuit(operator: number): boolean {
  return operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken || isLogicalAssignment(operator);
}

function patternOrLoopTarget(target: ts.Expression): boolean {
  let current: ts.Node = target;
  while (isPatternPart(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (current !== target && ts.isBinaryExpression(parent) && parent.left === current &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return true;
  }
  return (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current;
}

function isPatternPart(node: ts.Node): boolean {
  return ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node) || ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) || ts.isSpreadElement(node) || ts.isSpreadAssignment(node) ||
    ts.isParenthesizedExpression(node);
}

/** Tells if the node is the ancestor or the node itself. */
export function inside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

/** Tells if the node runs on every path through the owner, with no branch, loop, handler, or nested function around it. */
export function unconditional(node: ts.Node, owner: EffectOwner): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (isBranch(current)) {
      return false;
    }
  }
  return true;
}

function isBranch(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) || ts.isTryStatement(node) || isFunctionLike(node) ||
    (ts.isBinaryExpression(node) && isShortCircuit(node.operatorToken.kind));
}
