// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import * as expressions from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import * as owners from "./owners";
import * as resolution from "./resolution";
import type { Resolution } from "./resolution";

/** A class or an object literal whose members a receiver can select. */
export type Shape = ts.ClassLikeDeclaration | ts.ObjectLiteralExpression;

export function classTargets(
  model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding> = new Set(), ancestors: ReadonlySet<ts.Node> = new Set(),
): Resolution<ts.ClassLikeDeclaration> {
  const value = expressions.unwrapExpression(expression);
  const branches = alternatives(value);
  if (branches) {
    return resolution.join(branches.map(branch => classTargets(model, branch, seen, ancestors)));
  }
  if (ts.isClassExpression(value)) { return classShape(model, value, ancestors); }
  if (!ts.isIdentifier(value)) { return resolution.unresolved(); }
  const binding = model.resolve(value);
  if (!binding || seen.has(binding)) { return resolution.unresolved(); }
  return bindingClasses(model, binding, new Set(seen).add(binding), ancestors);
}

function alternatives(value: ts.Expression): readonly ts.Expression[] | undefined {
  if (ts.isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  return ts.isBinaryExpression(value) && assignments.isShortCircuit(value.operatorToken.kind) ? [value.left, value.right] : undefined;
}

function bindingClasses(
  model: ScopeModel, binding: Binding, seen: ReadonlySet<Binding>, ancestors: ReadonlySet<ts.Node>,
): Resolution<ts.ClassLikeDeclaration> {
  const groups = binding.declarations.flatMap(declaration => ts.isClassLike(declaration.node) ? [classShape(model, declaration.node, ancestors)] : []);
  groups.push(...assignments.bindingAssignments(binding).map(assignment => assignment.value && !assignment.element
    ? classTargets(model, assignment.value, seen, ancestors) : resolution.unresolved<ts.ClassLikeDeclaration>()));
  return groups.length > 0 ? resolution.join(groups) : resolution.unresolved();
}

export function classShape(model: ScopeModel, node: ts.ClassLikeDeclaration, seen: ReadonlySet<ts.Node> = new Set()): Resolution<ts.ClassLikeDeclaration> {
  if (seen.has(node)) { return resolution.unresolved([node]); }
  const decorated = (part: ts.Node): boolean => ts.canHaveDecorators(part) && (ts.getDecorators(part)?.length ?? 0) > 0;
  const immediate = decorated(node) || node.members.some(member => decorated(member) ||
    ((ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      member.parameters.some(decorated)));
  const base = owners.baseClassExpression(node);
  const parents = base ? classTargets(model, base, new Set(), new Set(seen).add(node)) : resolution.complete([]);
  return immediate || resolution.isDecorated(parents) ? resolution.decorated([node]) : resolution.complete([node]);
}

/** Gives every callable that a call can run, marked incomplete when some are not known. */
export type CallTargets = (call: ts.CallExpression, seen: ReadonlySet<Binding>) => Resolution<owners.EffectOwner>;

/** Gives the shapes the receiver can hold at the site, marked incomplete when some are not known or other code can replace their members. */
export function receiverShapes(
  model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>, site: ts.Node, callees: CallTargets = () => resolution.unresolved(),
): Resolution<Shape> {
  const value = expressions.unwrapExpression(expression);
  const branches = alternatives(value);
  if (branches) {
    return resolution.join(branches.map(branch => receiverShapes(model, branch, seen, site, callees)));
  }
  if (ts.isCallExpression(value)) {
    return returnedShapes(model, value, seen, callees);
  }
  if (ts.isNewExpression(value)) {
    return constructedShapes(model, value.expression);
  }
  if (ts.isObjectLiteralExpression(value)) {
    return literalShapes(model, value);
  }
  return namedShapes(model, value, seen, site, callees);
}

function namedShapes(model: ScopeModel, name: ts.Expression, seen: ReadonlySet<Binding>, site: ts.Node, callees: CallTargets): Resolution<Shape> {
  if (!ts.isIdentifier(name)) {
    return resolution.unresolved();
  }
  const classes = classTargets(model, name);
  if (classes.targets.length > 0) {
    return classes;
  }
  const binding = model.resolve(name);
  if (!binding || seen.has(binding)) { return resolution.unresolved(); }
  const selected = bindingShapes(model, binding, new Set(seen).add(binding), site, callees);
  return sealed(model, binding, site, new Set()) ? selected : resolution.inherit(selected, resolution.unresolved());
}

function constructedShapes(model: ScopeModel, constructor: ts.Expression): Resolution<Shape> {
  const classes = classTargets(model, constructor);
  return classes.complete && classes.targets.every(inertConstruction) ? classes : closedShapes(model, classes);
}

function inertConstruction(shape: ts.ClassLikeDeclaration): boolean {
  return !owners.baseClassExpression(shape) && !(ts.getDecorators(shape)?.length) &&
    shape.members.every((member) =>
      (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      !ts.isComputedPropertyName(member.name) && !(ts.getDecorators(member)?.length));
}

function literalShapes(model: ScopeModel, literal: ts.ObjectLiteralExpression): Resolution<Shape> {
  const setsPrototype = literal.properties.some((property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) &&
    expressions.keyName(property.name) === "__proto__");
  return setsPrototype ? resolution.unresolved() : closedShapes(model, resolution.complete([literal]));
}

function returnedShapes(model: ScopeModel, call: ts.CallExpression, seen: ReadonlySet<Binding>, callees: CallTargets): Resolution<Shape> {
  const targets = callees(call, seen);
  if (targets.targets.length === 0) {
    return resolution.inherit(targets, resolution.unresolved());
  }
  const found: Resolution<Shape>[] = [];
  for (const target of targets.targets) {
    const shapes = calleeShapes(model, target, (inner, visited) => {
      const resolved = callees(inner, visited);
      return resolved.targets.includes(target) ? resolution.inherit(resolved, resolution.unresolved()) : resolved;
    });
    found.push(shapes);
  }
  return resolution.inherit(targets, resolution.join(found));
}

function calleeShapes(model: ScopeModel, callee: owners.EffectOwner, callees: CallTargets): Resolution<Shape> {
  const values = owners.isGenerator(callee) || isAsync(callee) ? [] : returnedValues(callee);
  const selected = values.map((value) => receiverShapes(model, value, new Set(), value, callees));
  return selected.length === 0 ? resolution.unresolved() : resolution.join(selected);
}

function isAsync(owner: owners.EffectOwner): boolean {
  return ts.canHaveModifiers(owner) && (ts.getModifiers(owner) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function returnedValues(owner: owners.EffectOwner): ts.Expression[] {
  if (ts.isArrowFunction(owner) && !ts.isBlock(owner.body)) {
    return [owner.body];
  }
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      values.push(...(node.expression ? [node.expression] : []));
    } else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) {
      ts.forEachChild(node, visit);
    }
  };
  const body = ts.isFunctionLike(owner) ? (owner as { body?: ts.Node }).body : undefined;
  if (body) {
    ts.forEachChild(body, visit);
  }
  return values;
}

function bindingShapes(
  model: ScopeModel, binding: Binding, seen: ReadonlySet<Binding>, site: ts.Node, callees: CallTargets,
): Resolution<Shape> {
  const groups = assignments.bindingAssignments(binding).map(assignment => assignment.value && !assignment.element
    ? receiverShapes(model, assignment.value, seen, site, callees) : resolution.unresolved<Shape>());
  if (binding.declarations.some(declaration => declaration.kind === "parameter" || declaration.kind === "import")) {
    groups.push(resolution.unresolved());
  }
  return groups.length > 0 ? resolution.join(groups) : resolution.unresolved();
}

/** Gives the shapes, marked incomplete when code they run can hand their object to code that replaces its members. */
export function closedShapes(model: ScopeModel, shapes: Resolution<Shape>): Resolution<Shape> {
  return shapes.targets.every(shape => thisStaysInside(model, shape, new Set())) ? shapes
    : resolution.inherit(shapes, resolution.unresolved());
}

function thisStaysInside(model: ScopeModel, shape: Shape, seen: ReadonlySet<ts.Node>): boolean {
  const visit = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.ThisKeyword
    ? memberUse(model, node as ts.Expression)
    : !ts.forEachChild(node, (child) => visit(child) ? undefined : true);
  const base = ts.isClassLike(shape) ? owners.baseClassExpression(shape) : undefined;
  const parents = base ? classTargets(model, base).targets : [];
  return !seen.has(shape) && visit(shape) && parents.every((parent) => thisStaysInside(model, parent, new Set(seen).add(shape)));
}

function sealed(model: ScopeModel, binding: Binding, site: ts.Node, seen: ReadonlySet<Binding>): boolean {
  if (seen.has(binding)) {
    return true;
  }
  const next = new Set(seen).add(binding);
  const exported = binding.declarations.some((declaration) => ts.isVariableDeclaration(declaration.node) &&
    (ts.getCombinedModifierFlags(declaration.node) & ts.ModifierFlags.Export) !== 0);
  return !exported && binding.references.every((reference) =>
    !assignments.canRunBefore(reference, site) || closedUse(model, reference, site, next));
}

function closedUse(model: ScopeModel, reference: ts.Expression, site: ts.Node, seen: ReadonlySet<Binding>): boolean {
  const value = expressions.outerExpression(reference);
  const parent = value.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === value) {
    return sealedAlias(model, parent.name, site, seen);
  }
  return memberUse(model, reference) || ts.isSpreadAssignment(parent) || ts.isTypeQueryNode(parent) ||
    (ts.isBinaryExpression(parent) && parent.left === value && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}

function sealedAlias(model: ScopeModel, name: ts.Node, site: ts.Node, seen: ReadonlySet<Binding>): boolean {
  const alias = model.bindings.find((binding) => binding.declarations.some((declaration) => declaration.identifier === name));
  return ts.isObjectBindingPattern(name) || (!!alias && sealed(model, alias, site, seen));
}

function memberUse(model: ScopeModel, node: ts.Expression): boolean {
  const value = expressions.outerExpression(node);
  const access = value.parent;
  return (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === value &&
    (expressions.methodName(access) !== undefined || !model.writesMember(access));
}

export function descendsFrom(model: ScopeModel, candidate: ts.ClassLikeDeclaration, ancestor: ts.ClassLikeDeclaration, seen: ReadonlySet<ts.Node>): boolean {
  if (seen.has(candidate)) {
    return false;
  }
  const base = owners.baseClassExpression(candidate);
  return (base && classTargets(model, base).targets.some((parent) => parent === ancestor ||
    descendsFrom(model, parent, ancestor, new Set(seen).add(candidate)))) ?? false;
}

/** Tells if code outside the file can replace the member, as on an exported class whose member is not private. */
export function isOpenMember(owner: ts.ClassLikeDeclaration, name: string): boolean {
  const exported = owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const privateMember = owner.members.some((member) => expressions.declarationName(member) === name &&
    ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
  return !!exported && !privateMember;
}

export function openName(member: ts.Node): boolean {
  const name = (member as { name?: ts.Node }).name;
  if (!name || !ts.isComputedPropertyName(name)) {
    return false;
  }
  const key = expressions.unwrapExpression(name.expression);
  const symbol = ts.isPropertyAccessExpression(key) && ts.isIdentifier(key.expression) && key.expression.text === "Symbol";
  return !symbol && expressions.literalName(key) === undefined;
}

/** Gives the value a property member holds, as x for { add: x }, { x }, and a field initializer. */
/** Gives the properties of the literal that can hold the member: a later data member replaces the members before it. */
export function liveProperties(shape: ts.ObjectLiteralExpression, name: string): readonly ts.Node[] {
  const last = shape.properties.reduce((found, property, index) => expressions.declarationName(property) === name &&
    !ts.isGetAccessorDeclaration(property) && !ts.isSetAccessorDeclaration(property) ? index : found, 0);
  return shape.properties.slice(last);
}

export function memberValue(member: ts.Node): ts.Expression | undefined {
  if (ts.isShorthandPropertyAssignment(member)) {
    return member.name;
  }
  return ts.isPropertyDeclaration(member) || ts.isPropertyAssignment(member) ? member.initializer : undefined;
}
