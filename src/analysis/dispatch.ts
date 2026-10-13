import ts from "typescript";
import * as expressions from "../ast/expressions";
import { isFunctionLike, isFunctionLikeWithBody } from "../ast/functions";
import { writeTargets, type Binding, type ScopeModel } from "../ast/scopes";
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

// A plain name in an object pattern, as in "const { add } = api", takes the member the name selects.
function elementTargets(dispatch: Dispatch, binding: Binding, node: ts.Node, value: ts.Expression, seen: ReadonlySet<Binding>): Targets {
  const element = binding.declarations.find((declaration) => declaration.node === node)?.identifier.parent;
  if (!element || !ts.isBindingElement(element) || !ts.isObjectBindingPattern(element.parent) || element.parent.parent !== node ||
      element.dotDotDotToken || element.initializer) {
    return UNKNOWN;
  }
  const key = element.propertyName ?? element.name;
  const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
  return name === undefined ? UNKNOWN : namedTargets(dispatch, value, name, "call", seen, node);
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
  return namedTargets(dispatch, receiver, name, kind, seen, expression);
}

/** Gives the members a name selects on the value of the receiver at the site. */
function namedTargets(dispatch: Dispatch, receiver: ts.Expression, name: string, kind: MemberKind, seen: ReadonlySet<Binding>, site: ts.Node): Targets {
  const shapes = receiverShapes(dispatch.model, receiver, seen, site);
  if (shapes) {
    return joinTargets([...shapes.map((shape) => shapeMembers(dispatch, shape, name, kind, seen)), patchedTargets(site, name, kind)]);
  }
  // A global object holds no method of this file unless the file stores one there, which it reports as a write.
  if (ts.isIdentifier(receiver) && !dispatch.model.resolve(receiver)) {
    return UNKNOWN;
  }
  const candidates = dispatch.owners.filter((owner) => memberMatches(owner, name, kind));
  return { targets: candidates, complete: false };
}

// A method that code in the file replaces by name can hold any value.
function patchedTargets(site: ts.Node, name: string, kind: MemberKind): Targets {
  return kind === "call" && fileWrites(site.getSourceFile()).names.has(name) ? UNKNOWN : EMPTY;
}

function receiverShapes(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>, site: ts.Node): readonly ts.Node[] | undefined {
  const value = expressions.unwrapExpression(expression);
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
  return bindingShapes(model, binding, new Set(seen).add(binding), site);
}

function bindingShapes(model: ScopeModel, binding: Binding, seen: ReadonlySet<Binding>, site: ts.Node): readonly ts.Node[] | undefined {
  if (binding.declarations.some((declaration) => declaration.kind === "parameter" || declaration.kind === "import")) {
    return undefined;
  }
  const shapes: ts.Node[] = [];
  for (const assignment of assignments.bindingAssignments(binding)) {
    const targets = assignment.value && !assignment.element ? receiverShapes(model, assignment.value, seen, site) : undefined;
    if (!targets) {
      return undefined;
    }
    shapes.push(...targets);
  }
  return shapes.length > 0 ? shapes : undefined;
}

/** Gives the shapes when no code they run can hand their object to code that replaces its members. */
function closedShapes(model: ScopeModel, shapes: readonly ts.Node[] | undefined): readonly ts.Node[] | undefined {
  return shapes?.every((shape) => thisStaysInside(model, shape, new Set())) ? shapes : undefined;
}

function thisStaysInside(model: ScopeModel, shape: ts.Node, seen: ReadonlySet<ts.Node>): boolean {
  const visit = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.ThisKeyword
    ? memberUse(node as ts.Expression)
    : !ts.forEachChild(node, (child) => visit(child) ? undefined : true);
  const base = ts.isClassLike(shape) ? owners.baseClassExpression(shape) : undefined;
  const parents = base ? classTargets(model, base) ?? [] : [];
  return !seen.has(shape) && visit(shape) && parents.every((parent) => thisStaysInside(model, parent, new Set(seen).add(shape)));
}

/**
 * True when no use of the binding that can run before the site lets other code replace members of its object.
 * Reading or calling a named member, copying members out, and making an alias that is itself sealed keep the object closed.
 */
function sealed(model: ScopeModel, binding: Binding, site: ts.Node, seen: ReadonlySet<Binding>): boolean {
  if (seen.has(binding)) {
    return true;
  }
  const next = new Set(seen).add(binding);
  const exported = binding.declarations.some((declaration) => ts.isVariableDeclaration(declaration.node) &&
    ts.getModifiers(declaration.node.parent.parent as ts.VariableStatement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  return !exported && binding.references.every((reference) => !reaches(reference, site) || closedUse(model, reference, site, next));
}

function closedUse(model: ScopeModel, reference: ts.Identifier, site: ts.Node, seen: ReadonlySet<Binding>): boolean {
  const value = expressions.outerExpression(reference);
  const parent = value.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === value) {
    const alias = ts.isIdentifier(parent.name)
      ? model.bindings.find((binding) => binding.declarations.some((declaration) => declaration.identifier === parent.name))
      : undefined;
    return ts.isObjectBindingPattern(parent.name) || (!!alias && sealed(model, alias, site, seen));
  }
  return memberUse(reference) || ts.isSpreadAssignment(parent) || ts.isTypeQueryNode(parent) ||
    (ts.isBinaryExpression(parent) && parent.left === value && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}

// Reading a member, calling it, or writing one by name leaves the object where it is; a write by name is a patch the file records.
function memberUse(node: ts.Expression): boolean {
  const value = expressions.outerExpression(node);
  const access = value.parent;
  return (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === value &&
    (expressions.methodName(access) !== undefined || !fileWrites(node.getSourceFile()).targets.has(access));
}

function reaches(use: ts.Node, site: ts.Node): boolean {
  let owner: ts.Node = site.parent;
  while (!isFunctionLike(owner) && !ts.isClassLike(owner) && !ts.isSourceFile(owner)) {
    owner = owner.parent;
  }
  return !assignments.inside(use, owner) || assignments.canReachSite(use, owner as owners.EffectOwner, site);
}

type FileWrites = { readonly targets: ReadonlySet<ts.Node>; readonly names: ReadonlySet<string> };

// messcript-disable-next-line GlobalVariable
const fileWritesCache = new WeakMap<ts.SourceFile, FileWrites>();

/** Gives every member the file writes, and the names of the members it writes or defines by name. */
function fileWrites(sourceFile: ts.SourceFile): FileWrites {
  const cached = fileWritesCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const targets = new Set<ts.Node>();
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    for (const target of writeTargets(node)) {
      const value = expressions.unwrapExpression(target);
      targets.add(value);
      const name = (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) ? expressions.methodName(value) : undefined;
      if (name !== undefined) {
        names.add(name);
      }
    }
    for (const name of definedNames(node)) {
      names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const writes = { targets, names };
  fileWritesCache.set(sourceFile, writes);
  return writes;
}

// Object.defineProperty, Reflect.set, and Object.assign write members whose names they spell out.
function definedNames(node: ts.Node): string[] {
  if (!ts.isCallExpression(node)) {
    return [];
  }
  const callee = expressions.unwrapExpression(node.expression);
  const library = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : "";
  const [, key] = node.arguments;
  if (key && ts.isStringLiteralLike(expressions.unwrapExpression(key)) && DEFINERS.has(library)) {
    return [(expressions.unwrapExpression(key) as ts.StringLiteralLike).text];
  }
  return library === "Object.assign"
    ? node.arguments.slice(1).flatMap((source) => {
      const value = expressions.unwrapExpression(source);
      return ts.isObjectLiteralExpression(value) ? value.properties.flatMap((property) => declarationName(property) ?? []) : [];
    })
    : [];
}

const DEFINERS = new Set(["Object.defineProperty", "Reflect.defineProperty", "Reflect.set"]);

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
  groups.push(patchedTargets(node, name, kind));
  if (isOpenMember(owner, name) || !closedShapes(dispatch.model, [owner, ...subtypes])) {
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
  return ts.isClassLike(shape) ? classMembers(dispatch, shape, name, kind, new Set())
    : membersTargets(dispatch, (shape as ts.ObjectLiteralExpression).properties, name, kind, seen);
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
  const groups = members.flatMap((member): Targets[] => {
    if (ts.isSpreadAssignment(member)) {
      return [namedTargets(dispatch, member.expression, name, kind, seen, member)];
    }
    if (declarationName(member) !== name) {
      return openName(member) ? [UNKNOWN] : [];
    }
    if (memberMatches(member, name, kind)) {
      return [{ targets: [member], complete: true }];
    }
    const value = ts.isShorthandPropertyAssignment(member) ? member.name
      : ts.isPropertyDeclaration(member) || ts.isPropertyAssignment(member) ? member.initializer : undefined;
    return kind === "call" && value ? [callableTargets(dispatch, value, seen)] : [];
  });
  return joinTargets(groups);
}

// A computed name other than a literal or a symbol can be any member name.
function openName(member: ts.Node): boolean {
  const name = (member as { name?: ts.Node }).name;
  if (!name || !ts.isComputedPropertyName(name)) {
    return false;
  }
  const key = expressions.unwrapExpression(name.expression);
  const symbol = ts.isPropertyAccessExpression(key) && ts.isIdentifier(key.expression) && key.expression.text === "Symbol";
  return !symbol && literalName(key) === undefined;
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
      !ts.isPropertyDeclaration(node) && !ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
    return undefined;
  }
  const name = node.name;
  if (ts.isComputedPropertyName(name)) {
    return literalName(expressions.unwrapExpression(name.expression));
  }
  return ts.isIdentifier(name) ? name.text : literalName(name);
}

function literalName(name: ts.Node): string | undefined {
  return ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}
