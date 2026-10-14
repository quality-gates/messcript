import ts from "typescript";
import * as expressions from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import * as owners from "./owners";

/** A class or an object literal whose members a receiver can select. */
export type Shape = ts.ClassLikeDeclaration | ts.ObjectLiteralExpression;

export function classTargets(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding> = new Set()): readonly ts.ClassLikeDeclaration[] | undefined {
  const value = expressions.unwrapExpression(expression);
  if (ts.isClassExpression(value)) {
    return [value];
  }
  if (!ts.isIdentifier(value)) {
    return undefined;
  }
  const binding = model.resolve(value);
  if (!binding || seen.has(binding)) {
    return undefined;
  }
  return bindingClasses(model, binding, new Set(seen).add(binding));
}

function bindingClasses(model: ScopeModel, binding: Binding, seen: ReadonlySet<Binding>): readonly ts.ClassLikeDeclaration[] | undefined {
  const classes = binding.declarations.flatMap((declaration) => ts.isClassLike(declaration.node) ? [declaration.node] : []);
  for (const assignment of assignments.bindingAssignments(binding)) {
    if (!assignment.value || assignment.element) {
      return undefined;
    }
    const targets = classTargets(model, assignment.value, seen);
    if (!targets) {
      return undefined;
    }
    classes.push(...targets);
  }
  return classes.length > 0 ? [...new Set(classes)] : undefined;
}

/** Gives every callable that a call can run, or undefined when some are not known. */
export type CallTargets = (call: ts.CallExpression) => readonly owners.EffectOwner[] | undefined;

/** Gives the shapes the receiver can hold at the site, or undefined when other code can replace their members. */
export function receiverShapes(
  model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>, site: ts.Node, callees: CallTargets = () => undefined,
): readonly Shape[] | undefined {
  const value = expressions.unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    return returnedShapes(model, value, callees);
  }
  if (ts.isNewExpression(value)) {
    return closedShapes(model, classTargets(model, value.expression));
  }
  if (ts.isObjectLiteralExpression(value)) {
    return closedShapes(model, [value]);
  }
  if (!ts.isIdentifier(value)) {
    return undefined;
  }
  const classes = classTargets(model, value);
  if (classes) {
    return classes;
  }
  const binding = model.resolve(value);
  if (!binding || seen.has(binding) || !sealed(model, binding, site, new Set())) {
    return undefined;
  }
  return bindingShapes(model, binding, new Set(seen).add(binding), site, callees);
}

function returnedShapes(model: ScopeModel, call: ts.CallExpression, callees: CallTargets): readonly Shape[] | undefined {
  const targets = callees(call);
  if (!targets || targets.length === 0) {
    return undefined;
  }
  const found: Shape[] = [];
  for (const target of targets) {
    const shapes = calleeShapes(model, target, (inner) => {
      const resolved = callees(inner);
      return resolved?.includes(target) ? undefined : resolved;
    });
    if (!shapes) {
      return undefined;
    }
    found.push(...shapes);
  }
  return found;
}

function calleeShapes(model: ScopeModel, callee: owners.EffectOwner, callees: CallTargets): readonly Shape[] | undefined {
  const values = owners.isGenerator(callee) || isAsync(callee) ? [] : returnedValues(callee);
  const selected = values.map((value) => receiverShapes(model, value, new Set(), value, callees));
  return selected.length === 0 || selected.some((group) => group === undefined) ? undefined : selected.flatMap((group) => group ?? []);
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
): readonly Shape[] | undefined {
  if (binding.declarations.some((declaration) => declaration.kind === "parameter" || declaration.kind === "import")) {
    return undefined;
  }
  const shapes: Shape[] = [];
  for (const assignment of assignments.bindingAssignments(binding)) {
    const targets = assignment.value && !assignment.element ? receiverShapes(model, assignment.value, seen, site, callees) : undefined;
    if (!targets) {
      return undefined;
    }
    shapes.push(...targets);
  }
  return shapes.length > 0 ? shapes : undefined;
}

/** Gives the shapes when no code they run can hand their object to code that replaces its members. */
export function closedShapes(model: ScopeModel, shapes: readonly Shape[] | undefined): readonly Shape[] | undefined {
  return shapes?.every((shape) => thisStaysInside(model, shape, new Set())) ? shapes : undefined;
}

function thisStaysInside(model: ScopeModel, shape: Shape, seen: ReadonlySet<ts.Node>): boolean {
  const visit = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.ThisKeyword
    ? memberUse(model, node as ts.Expression)
    : !ts.forEachChild(node, (child) => visit(child) ? undefined : true);
  const base = ts.isClassLike(shape) ? owners.baseClassExpression(shape) : undefined;
  const parents = base ? classTargets(model, base) ?? [] : [];
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
  return (base && classTargets(model, base)?.some((parent) => parent === ancestor ||
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
