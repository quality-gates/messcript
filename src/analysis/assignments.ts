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
    return deferred(site, owner) ? [{ ...assignment, join: true }] : [];
  }
  return [dominates(assignment.node, owner, site) ? assignment : { ...assignment, join: true }];
}

export function canReachSite(node: ts.Node, owner: EffectOwner, site: ts.Node): boolean {
  return node.end <= site.getStart() || deferred(node, owner) || deferred(site, owner) || repeated({ node }, owner, site);
}

function repeated(assignment: Assignment, owner: EffectOwner, site: ts.Node): boolean {
  for (let current: ts.Node | undefined = site.parent; current && current !== owner; current = current.parent) {
    if (ts.isIterationStatement(current, false) && inside(assignment.node, current)) {
      return assignment.node.end > site.getStart() || !dominates(assignment.node, owner, site);
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
    return { node: loop.statement, value: loop.expression, element: true, iterated: true, join: true, pattern: identifier };
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

/** The most names a module constant's contents may refer to and still be tracked member by member. */
const MAX_HELD_NAMES = 64;
/** Resolves a name to its binding and tells if a reference to it replaces its value. */
type NameLookup = {
  resolve(identifier: ts.Identifier): Binding | undefined;
  writeOf(node: ts.Node): { readonly reassign: boolean } | undefined;
};

/** Constructors whose fresh instance holds the storage its arguments supply, unlike "new Date(time)". */
const CONTAINER_CONSTRUCTORS = new Set(["Array", "Map", "Set", "WeakMap", "WeakSet"]);

/**
 * Gives the declaration that fills a module constant with a fresh array or container of other names, as in
 * "const copy = [...rows]". A container filled from a name that is later reassigned is left out, since it keeps the old value.
 */
export function ambientContents(binding: Binding, owner: EffectOwner, model: NameLookup): (Assignment & { readonly value: ts.Expression }) | undefined {
  if (!ts.isSourceFile(binding.scope.node) || inside(binding.scope.node, owner)) { return undefined; }
  const node = binding.declarations.map((item) => item.node).find(ts.isVariableDeclaration);
  const value = node && freshConstant(node);
  return node && value && holdsStableNames(value, model) ? { node, value } : undefined;
}

/** Tells if a value refers to a few names, none of them reassigned later. */
function holdsStableNames(value: ts.Expression, model: NameLookup): boolean {
  const names = referencedNames(value, []);
  return names.length > 0 && names.length <= MAX_HELD_NAMES && !names.some((name) => reassignedName(model, name));
}

function freshConstant(node: ts.VariableDeclaration): ts.Expression | undefined {
  const value = ts.isIdentifier(node.name) && node.parent.flags & ts.NodeFlags.Const ? node.initializer : undefined;
  const fresh = value && unwrapExpression(value);
  return fresh && (ts.isArrayLiteralExpression(fresh) || isContainerConstruction(fresh)) ? value : undefined;
}

/**
 * Gives the names a value refers to, leaving out property keys such as "x" in "{ x: 1 }". Stops once there are more than
 * MAX_HELD_NAMES, since a large table is read at every use and is not worth tracking member by member.
 */
function referencedNames(value: ts.Node, names: ts.Identifier[]): ts.Identifier[] {
  ts.forEachChild(value, (child) => {
    if (ts.isIdentifier(child) && !(ts.isPropertyAssignment(value) && value.name === child)) {
      names.push(child);
    } else if (!ts.isIdentifier(child)) {
      referencedNames(child, names);
    }
    return names.length > MAX_HELD_NAMES || undefined;
  });
  return names;
}

function reassignedName(model: NameLookup, name: ts.Identifier): boolean {
  return model.resolve(name)?.references.some((reference) => model.writeOf(reference)?.reassign) ?? false;
}

function isContainerConstruction(value: ts.Expression): boolean {
  return ts.isNewExpression(value) && ts.isIdentifier(value.expression) && CONTAINER_CONSTRUCTORS.has(value.expression.text);
}

function isNameOrMember(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  return ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value);
}

/** Gives the value that the reference receives when the reference is an assignment target. */
export function referenceAssignment(reference: ts.Identifier): Assignment | undefined {
  const target = outerExpression(reference);
  const parent = target.parent;
  if (ts.isBinaryExpression(parent) && parent.left === target) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.EqualsToken) {
      return { node: parent, value: parent.right };
    }
    return isLogicalAssignment(operator) ? { node: parent, value: parent.right, join: true } : undefined;
  }
  if (ts.isForOfStatement(parent) && parent.initializer === target) {
    return { node: parent.statement, value: parent.expression, element: true, iterated: true, pattern: reference, join: true };
  }
  return patternOrLoopTarget(target) ? elementValue(target) ?? { node: target, join: true } : undefined;
}

function elementValue(node: ts.Expression): { readonly node: ts.Node; readonly value: ts.Expression } | undefined {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node && !isPatternPart(parent.parent)) {
    return { node: parent, value: parent.right };
  }
  if (!ts.isArrayLiteralExpression(parent)) {
    return undefined;
  }
  const outer = elementValue(parent);
  const value = outer && positionalElement(outer.value, parent.elements.indexOf(node));
  return outer && value ? { node: outer.node, value } : undefined;
}

function positionalElement(value: ts.Expression, index: number): ts.Expression | undefined {
  const source = unwrapExpression(value);
  const elements = ts.isArrayLiteralExpression(source) ? source.elements.slice(0, index + 1) : [];
  return elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)) ? undefined : elements[index];
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
  if (node.pos >= 0 && ancestor.pos >= 0 && (node.pos < ancestor.pos || node.end > ancestor.end)) {
    return false;
  }
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

function dominates(node: ts.Node, owner: EffectOwner, site: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if ((isBranch(current) && !knownBranch(current)) || (ts.isCaseOrDefaultClause(current) && !inside(site, current))) {
      return false;
    }
    if (inside(site, current)) {
      return true;
    }
  }
  return true;
}

function isBranch(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isLabeledStatement(node) || isFunctionLike(node) ||
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
