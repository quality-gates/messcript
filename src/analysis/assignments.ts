import ts from "typescript";
import { isFunctionLike } from "../ast/functions";
import { outerExpression, unwrapExpression } from "../ast/expressions";
import type { Binding } from "../ast/scopes";
import { isReachable, reachableChildren } from "./control-flow";
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
  /** The value is iterated, as in a for-of loop, and the binding receives its elements. */
  readonly iterated?: boolean;
  /** The name a destructuring pattern binds, which selects the element from the value. */
  readonly pattern?: ts.Identifier;
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
  if (deferred(assignment.node, owner) || !isReachable(assignment.node, owner)) {
    return [];
  }
  if (repeated(assignment, owner, site)) {
    return [{ ...assignment, join: true }];
  }
  if (assignment.node.end > site.getStart()) {
    return [];
  }
  return [unconditional(assignment.node, owner) ? assignment : { ...assignment, join: true }];
}

export function canReachSite(node: ts.Node, owner: EffectOwner, site: ts.Node): boolean {
  return node.end <= site.getStart() || deferred(node, owner) || repeated({ node }, owner, site);
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

export function declarationAssignment(node: ts.Node, identifier: ts.Identifier): Assignment | undefined {
  if (!ts.isVariableDeclaration(node)) {
    return undefined;
  }
  if (ts.isCatchClause(node.parent)) {
    return { node, join: true };
  }
  const loop = node.parent.parent;
  if (ts.isForOfStatement(loop) && loop.initializer === node.parent) {
    return { node: loop.statement, value: loop.expression, element: true, iterated: true, join: true, ...(node.name === identifier ? {} : { pattern: identifier }) };
  }
  if (!node.initializer || ts.isForInStatement(loop)) {
    return undefined;
  }
  return { node, value: node.initializer, ...(node.name === identifier ? {} : { element: true, pattern: identifier }) };
}

/** Gives the declaration that makes a binding outside the owner an alias of a name or member, as in "const items = store.items". */
export function ambientAlias(binding: Binding, owner: EffectOwner): (Assignment & { readonly value: ts.Expression }) | undefined {
  const declaration = inside(binding.scope.node, owner) ? undefined : binding.declarations.find((item) => ts.isVariableDeclaration(item.node));
  const assignment = declaration && declarationAssignment(declaration.node, declaration.identifier);
  return assignment?.value && ts.isVariableDeclaration(assignment.node) && isNameOrMember(assignment.value) ? { ...assignment, value: assignment.value } : undefined;
}

function isNameOrMember(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  return ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value);
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

/** Tells if the use can run before the site. A use outside the function, class, or file that holds the site can run at any time. */
export function canRunBefore(use: ts.Node, site: ts.Node): boolean {
  let owner: ts.Node = site.parent;
  while (!isOwner(owner)) {
    owner = owner.parent;
  }
  return !inside(use, owner) || canReachSite(use, owner, site);
}

function isOwner(node: ts.Node): node is EffectOwner {
  return isFunctionLike(node) || ts.isClassLike(node) || ts.isSourceFile(node);
}

/** Tells if the node runs on every path through the owner, with no branch, loop, handler, or nested function around it. */
export function unconditional(node: ts.Node, owner: EffectOwner): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (isBranch(current) && !knownBranch(current)) {
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

function knownBranch(node: ts.Node): boolean {
  const children = reachableChildren(node);
  if (!children || children.length === 0) {
    return false;
  }
  const condition = ts.isIfStatement(node) ? unwrapExpression(node.expression) : children[0];
  return condition.kind === ts.SyntaxKind.TrueKeyword || condition.kind === ts.SyntaxKind.FalseKeyword;
}
