import ts from "typescript";
import * as expressions from "../ast/expressions";
import { isFunctionLikeWithBody } from "../ast/functions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import * as owners from "./owners";

export type Targets = { readonly targets: readonly owners.EffectOwner[]; readonly complete: boolean };
export type Dispatch = {
  readonly model: ScopeModel;
  readonly owners: readonly owners.EffectOwner[];
  readonly returns: (call: ts.CallExpression, seen: ReadonlySet<Binding>) => Targets;
};

type MemberKind = "call" | "get" | "set";

const EMPTY: Targets = { targets: [], complete: true };
const UNKNOWN: Targets = { targets: [], complete: false };

export function joinTargets(groups: readonly Targets[]): Targets {
  return { targets: [...new Set(groups.flatMap((group) => group.targets))], complete: groups.every((group) => group.complete) };
}

export function callableTargets(dispatch: Dispatch, expression: ts.Expression, seen: ReadonlySet<Binding> = new Set()): Targets {
  const value = expressions.unwrapExpression(expression);
  if (isFunctionLikeWithBody(value)) {
    return { targets: [value], complete: true };
  }
  if (ts.isIdentifier(value)) {
    const binding = dispatch.model.resolve(value);
    return binding ? bindingTargets(dispatch, binding, seen) : UNKNOWN;
  }
  if (ts.isCallExpression(value)) {
    return dispatch.returns(value, seen);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return memberTargets(dispatch, value, "call", seen);
  }
  return compoundTargets(dispatch, value, seen);
}

function compoundTargets(dispatch: Dispatch, value: ts.Expression, seen: ReadonlySet<Binding>): Targets {
  if (ts.isConditionalExpression(value)) {
    return joinTargets([callableTargets(dispatch, value.whenTrue, seen), callableTargets(dispatch, value.whenFalse, seen)]);
  }
  if (ts.isBinaryExpression(value)) {
    if (assignments.isShortCircuit(value.operatorToken.kind)) {
      return joinTargets([callableTargets(dispatch, value.left, seen), callableTargets(dispatch, value.right, seen)]);
    }
    return value.operatorToken.kind === ts.SyntaxKind.CommaToken || value.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? callableTargets(dispatch, value.right, seen) : EMPTY;
  }
  if (isNonCallable(value)) {
    return EMPTY;
  }
  return UNKNOWN;
}

function isNonCallable(value: ts.Expression): boolean {
  return ts.isLiteralExpression(value) || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) ||
    value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword;
}

function bindingTargets(dispatch: Dispatch, binding: Binding, seen: ReadonlySet<Binding>): Targets {
  if (seen.has(binding)) {
    return UNKNOWN;
  }
  const next = new Set(seen).add(binding);
  const functions = binding.declarations.flatMap((declaration) =>
    ts.isFunctionDeclaration(declaration.node) && declaration.node.body ? [declaration.node] : [],
  );
  const assigned = assignments.bindingAssignments(binding);
  const groups = assigned.map((assignment) => assignment.value && !assignment.element
    ? callableTargets(dispatch, assignment.value, next)
    : UNKNOWN);
  if (functions.length > 0) {
    groups.push({ targets: functions, complete: true });
  }
  if (binding.declarations.some((declaration) => declaration.kind === "parameter" || declaration.kind === "import")) {
    groups.push(UNKNOWN);
  }
  return groups.length > 0 ? joinTargets(groups) : UNKNOWN;
}

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

export function memberTargets(dispatch: Dispatch, expression: ts.Expression, kind: MemberKind, seen: ReadonlySet<Binding> = new Set()): Targets {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return UNKNOWN;
  }
  const name = expressions.methodName(expression);
  if (name === undefined) {
    return UNKNOWN;
  }
  const receiver = expressions.unwrapExpression(expression.expression);
  if (receiver.kind === ts.SyntaxKind.ThisKeyword || receiver.kind === ts.SyntaxKind.SuperKeyword) {
    return receiverTargets(dispatch, expression, name, kind, receiver.kind === ts.SyntaxKind.SuperKeyword);
  }
  const shapes = receiverShapes(dispatch.model, receiver, seen);
  if (shapes) {
    return joinTargets(shapes.map((shape) => shapeMembers(dispatch, shape, name, kind, seen)));
  }
  const candidates = dispatch.owners.filter((owner) => memberMatches(owner, name, kind));
  return { targets: candidates, complete: false };
}

function receiverShapes(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>): readonly ts.Node[] | undefined {
  const value = expressions.unwrapExpression(expression);
  if (ts.isNewExpression(value)) {
    return classTargets(model, value.expression);
  }
  if (ts.isObjectLiteralExpression(value)) {
    return [value];
  }
  if (!ts.isIdentifier(value)) {
    return undefined;
  }
  const classes = classTargets(model, value);
  if (classes) {
    return classes;
  }
  const binding = model.resolve(value);
  if (!binding || seen.has(binding)) {
    return undefined;
  }
  return bindingShapes(model, binding, new Set(seen).add(binding));
}

function bindingShapes(model: ScopeModel, binding: Binding, seen: ReadonlySet<Binding>): readonly ts.Node[] | undefined {
  const shapes: ts.Node[] = [];
  for (const assignment of assignments.bindingAssignments(binding)) {
    if (!assignment.value || assignment.element) {
      return undefined;
    }
    const targets = receiverShapes(model, assignment.value, seen);
    if (!targets || (binding.mutated && targets.some(ts.isObjectLiteralExpression))) {
      return undefined;
    }
    shapes.push(...targets);
  }
  return shapes.length > 0 ? shapes : undefined;
}

function receiverTargets(dispatch: Dispatch, node: ts.Node, name: string, kind: MemberKind, baseOnly: boolean): Targets {
  const owner = owners.enclosingClass(node);
  if (!owner) {
    return UNKNOWN;
  }
  const base = owners.baseClassExpression(owner);
  if (baseOnly) {
    const classes = base && classTargets(dispatch.model, base);
    return classes ? joinTargets(classes.map((shape) => classMembers(dispatch, shape, name, kind, new Set()))) : UNKNOWN;
  }
  const classes = [...new Set(dispatch.owners.flatMap((candidate) => {
    const enclosing = owners.enclosingClass(candidate);
    return ts.isClassLike(candidate) ? [candidate] : enclosing ? [enclosing] : [];
  }))];
  const subtypes = classes.filter((candidate) => descendsFrom(dispatch.model, candidate, owner, new Set()));
  const groups = [owner, ...subtypes].map((candidate) => classMembers(dispatch, candidate, name, kind, new Set()));
  if (isOpenMember(owner, name)) {
    groups.push(UNKNOWN);
  }
  return joinTargets(groups);
}

function isOpenMember(owner: ts.ClassLikeDeclaration, name: string): boolean {
  const exported = owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const privateMember = owner.members.some((member) => declarationName(member) === name &&
    ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
  return !!exported && !privateMember;
}

function descendsFrom(model: ScopeModel, candidate: ts.ClassLikeDeclaration, ancestor: ts.ClassLikeDeclaration, seen: ReadonlySet<ts.Node>): boolean {
  if (seen.has(candidate)) {
    return false;
  }
  const base = owners.baseClassExpression(candidate);
  return (base && classTargets(model, base)?.some((parent) => parent === ancestor ||
    descendsFrom(model, parent, ancestor, new Set(seen).add(candidate)))) ?? false;
}

function shapeMembers(dispatch: Dispatch, shape: ts.Node, name: string, kind: MemberKind, seen: ReadonlySet<Binding>): Targets {
  if (ts.isClassLike(shape)) {
    return classMembers(dispatch, shape, name, kind, new Set());
  }
  return ts.isObjectLiteralExpression(shape) ? membersTargets(dispatch, shape.properties, name, kind, seen) : UNKNOWN;
}

function classMembers(dispatch: Dispatch, shape: ts.ClassLikeDeclaration, name: string, kind: MemberKind, seen: ReadonlySet<ts.Node>): Targets {
  if (seen.has(shape)) {
    return UNKNOWN;
  }
  const own = membersTargets(dispatch, shape.members, name, kind, new Set());
  if (own.targets.length > 0 || !own.complete) {
    return own;
  }
  const base = owners.baseClassExpression(shape);
  if (!base) {
    return own;
  }
  const parents = classTargets(dispatch.model, base);
  return parents ? joinTargets(parents.map((parent) => classMembers(dispatch, parent, name, kind, new Set(seen).add(shape)))) : UNKNOWN;
}

function membersTargets(dispatch: Dispatch, members: readonly ts.Node[], name: string, kind: MemberKind, seen: ReadonlySet<Binding>): Targets {
  const groups = members.filter((member) => declarationName(member) === name).flatMap((member) => {
    if (memberMatches(member, name, kind)) {
      return [{ targets: [member], complete: true } satisfies Targets];
    }
    if (kind === "call" && (ts.isPropertyDeclaration(member) || ts.isPropertyAssignment(member)) && member.initializer) {
      return [callableTargets(dispatch, member.initializer, seen)];
    }
    return [];
  });
  return joinTargets(groups);
}

function memberMatches(node: ts.Node, name: string, kind: MemberKind): node is owners.EffectOwner {
  if (!isFunctionLikeWithBody(node) || declarationName(node) !== name) {
    return false;
  }
  return kind === "get" ? ts.isGetAccessorDeclaration(node)
    : kind === "set" ? ts.isSetAccessorDeclaration(node)
      : ts.isMethodDeclaration(node);
}

function declarationName(node: ts.Node): string | undefined {
  if (!ts.isMethodDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node) &&
      !ts.isPropertyDeclaration(node) && !ts.isPropertyAssignment(node)) {
    return undefined;
  }
  const name = node.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}
