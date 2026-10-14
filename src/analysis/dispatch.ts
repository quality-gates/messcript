import ts from "typescript";
import * as expressions from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import * as owners from "./owners";
import * as shapes from "./shapes";

export type Targets = { readonly targets: readonly owners.EffectOwner[]; readonly complete: boolean };
export type Dispatch = {
  readonly model: ScopeModel;
  readonly owners: readonly owners.EffectOwner[];
  readonly returns: (call: ts.CallExpression, seen: ReadonlySet<Binding>) => Targets;
  readonly assignments: typeof assignments.bindingAssignments;
};

type MemberKind = "call" | "get" | "set";

const EMPTY: Targets = { targets: [], complete: true };
const UNKNOWN: Targets = { targets: [], complete: false };

const MEMBER_KINDS = { call: ts.isMethodDeclaration, get: ts.isGetAccessorDeclaration, set: ts.isSetAccessorDeclaration };

export function joinTargets(groups: readonly Targets[]): Targets {
  return { targets: [...new Set(groups.flatMap((group) => group.targets))], complete: groups.every((group) => group.complete) };
}

export function callableTargets(dispatch: Dispatch, expression: ts.Expression, seen: ReadonlySet<Binding> = new Set()): Targets {
  const value = expressions.unwrapExpression(expression);
  if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
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
  const assigned = dispatch.assignments(binding);
  const groups = assigned.map((assignment) => !assignment.value ? UNKNOWN
    : assignment.element ? elementTargets(dispatch, binding, assignment.node, assignment.value, next)
      : callableTargets(dispatch, assignment.value, next));
  if (functions.length > 0) {
    groups.push({ targets: functions, complete: true });
  }
  if (binding.declarations.some((declaration) => declaration.kind === "parameter" || declaration.kind === "import")) {
    groups.push(UNKNOWN);
  }
  return groups.length > 0 ? joinTargets(groups) : UNKNOWN;
}

function elementTargets(dispatch: Dispatch, binding: Binding, node: ts.Node, value: ts.Expression, seen: ReadonlySet<Binding>): Targets {
  const name = patternName(binding.declarations.find((declaration) => declaration.node === node)?.identifier.parent, node);
  return name === undefined ? UNKNOWN : namedTargets(dispatch, value, name, "call", seen, node);
}

function patternName(element: ts.Node | undefined, declaration: ts.Node): string | undefined {
  if (!element || !ts.isBindingElement(element) || !ts.isObjectBindingPattern(element.parent) || element.parent.parent !== declaration ||
      element.dotDotDotToken || element.initializer) {
    return undefined;
  }
  return expressions.keyName(element.propertyName ?? element.name);
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
  return namedTargets(dispatch, receiver, name, kind, seen, expression);
}

function namedTargets(dispatch: Dispatch, receiver: ts.Expression, name: string, kind: MemberKind, seen: ReadonlySet<Binding>, site: ts.Node): Targets {
  const selected = shapes.receiverShapes(dispatch.model, receiver, seen, site, (call) => {
    const callees = callableTargets(dispatch, call.expression, seen);
    return callees.complete ? callees.targets : undefined;
  });
  if (selected) {
    return joinTargets([...selected.map((shape) => ts.isClassLike(shape) ? classMembers(dispatch, shape, name, kind, new Set())
      : membersTargets(dispatch, shapes.liveProperties(shape, name), name, kind, seen)), patchedTargets(dispatch, name, kind)]);
  }
  if (ts.isIdentifier(receiver) && !dispatch.model.resolve(receiver)) {
    return UNKNOWN;
  }
  const candidates = dispatch.owners.filter((owner) => memberMatches(owner, name, kind));
  return { targets: candidates, complete: false };
}

function patchedTargets(dispatch: Dispatch, name: string, kind: MemberKind): Targets {
  return kind === "call" && dispatch.model.writesMemberName(name) ? UNKNOWN : EMPTY;
}

function receiverTargets(dispatch: Dispatch, node: ts.Node, name: string, kind: MemberKind, baseOnly: boolean): Targets {
  const owner = owners.enclosingClass(node);
  if (!owner) {
    return UNKNOWN;
  }
  const base = owners.baseClassExpression(owner);
  if (baseOnly) {
    const classes = base && shapes.classTargets(dispatch.model, base);
    return classes ? joinTargets(classes.map((shape) => classMembers(dispatch, shape, name, kind, new Set()))) : UNKNOWN;
  }
  const classes = [...new Set(dispatch.owners.flatMap((candidate) => {
    const enclosing = owners.enclosingClass(candidate);
    return ts.isClassLike(candidate) ? [candidate] : enclosing ? [enclosing] : [];
  }))];
  const subtypes = classes.filter((candidate) => shapes.descendsFrom(dispatch.model, candidate, owner, new Set()));
  const groups = [owner, ...subtypes].map((candidate) => classMembers(dispatch, candidate, name, kind, new Set()));
  groups.push(patchedTargets(dispatch, name, kind));
  if (shapes.isOpenMember(owner, name) || !shapes.closedShapes(dispatch.model, [owner, ...subtypes])) {
    groups.push(UNKNOWN);
  }
  return joinTargets(groups);
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
  const parents = shapes.classTargets(dispatch.model, base);
  return parents ? joinTargets(parents.map((parent) => classMembers(dispatch, parent, name, kind, new Set(seen).add(shape)))) : UNKNOWN;
}

function membersTargets(dispatch: Dispatch, members: readonly ts.Node[], name: string, kind: MemberKind, seen: ReadonlySet<Binding>): Targets {
  return joinTargets(members.flatMap((member) => entryTargets(dispatch, member, name, kind, seen)));
}

function entryTargets(dispatch: Dispatch, member: ts.Node, name: string, kind: MemberKind, seen: ReadonlySet<Binding>): Targets[] {
  if (ts.isSpreadAssignment(member)) {
    return [namedTargets(dispatch, member.expression, name, kind, seen, member)];
  }
  if (expressions.declarationName(member) !== name) {
    return shapes.openName(member) ? [UNKNOWN] : [];
  }
  if (memberMatches(member, name, kind)) {
    return [{ targets: [member], complete: true }];
  }
  const value = shapes.memberValue(member);
  return kind === "call" && value ? [callableTargets(dispatch, value, seen)] : [];
}

function memberMatches(node: ts.Node, name: string, kind: MemberKind): node is owners.EffectOwner {
  return MEMBER_KINDS[kind](node) && node.body !== undefined && expressions.declarationName(node) === name;
}
