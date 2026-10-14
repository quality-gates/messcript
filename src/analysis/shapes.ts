import ts from "typescript";
import * as expressions from "../ast/expressions";
import { writeTargets, type Binding, type ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import * as owners from "./owners";

/** A class or an object literal whose members a receiver can select. */
export type Shape = ts.ClassLikeDeclaration | ts.ObjectLiteralExpression;

type FileWrites = { readonly targets: ReadonlySet<ts.Node>; readonly names: ReadonlySet<string> };

const DEFINERS = new Set(["Object.defineProperty", "Reflect.defineProperty", "Reflect.set"]);

// messcript-disable-next-line GlobalVariable
const FILE_WRITES = new WeakMap<ts.SourceFile, FileWrites>();

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

/** Gives the shapes the receiver can hold at the site, or undefined when other code can replace their members. */
export function receiverShapes(model: ScopeModel, expression: ts.Expression, seen: ReadonlySet<Binding>, site: ts.Node): readonly Shape[] | undefined {
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

function bindingShapes(model: ScopeModel, binding: Binding, seen: ReadonlySet<Binding>, site: ts.Node): readonly Shape[] | undefined {
  if (binding.declarations.some((declaration) => declaration.kind === "parameter" || declaration.kind === "import")) {
    return undefined;
  }
  const shapes: Shape[] = [];
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
export function closedShapes(model: ScopeModel, shapes: readonly Shape[] | undefined): readonly Shape[] | undefined {
  return shapes?.every((shape) => thisStaysInside(model, shape, new Set())) ? shapes : undefined;
}

function thisStaysInside(model: ScopeModel, shape: Shape, seen: ReadonlySet<ts.Node>): boolean {
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
  return memberUse(reference) || ts.isSpreadAssignment(parent) || ts.isTypeQueryNode(parent) ||
    (ts.isBinaryExpression(parent) && parent.left === value && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}

// An object pattern copies members out. A plain name is an alias that must be sealed too.
function sealedAlias(model: ScopeModel, name: ts.Node, site: ts.Node, seen: ReadonlySet<Binding>): boolean {
  const alias = model.bindings.find((binding) => binding.declarations.some((declaration) => declaration.identifier === name));
  return ts.isObjectBindingPattern(name) || (!!alias && sealed(model, alias, site, seen));
}

// Reading a member, calling it, or writing one by name leaves the object where it is; a write by name is a patch the file records.
function memberUse(node: ts.Expression): boolean {
  const value = expressions.outerExpression(node);
  const access = value.parent;
  return (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === value &&
    (expressions.methodName(access) !== undefined || !fileWrites(node.getSourceFile()).targets.has(access));
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
  const privateMember = owner.members.some((member) => declarationName(member) === name &&
    ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
  return !!exported && !privateMember;
}

/** Tells if code in the file of the site replaces a member with this name. */
export function patchedName(site: ts.Node, name: string): boolean {
  return fileWrites(site.getSourceFile()).names.has(name);
}

/** Gives every member the file writes, and the names of the members it writes or defines by name. */
function fileWrites(sourceFile: ts.SourceFile): FileWrites {
  const cached = FILE_WRITES.get(sourceFile);
  if (cached) {
    return cached;
  }
  const targets = new Set<ts.Node>();
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    for (const target of writeTargets(node)) {
      const value = expressions.unwrapExpression(target);
      targets.add(value);
      const name = expressions.methodName(value);
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
  FILE_WRITES.set(sourceFile, writes);
  return writes;
}

// Object.defineProperty, Reflect.set, and Object.assign write members whose names they spell out.
function definedNames(node: ts.Node): string[] {
  if (!ts.isCallExpression(node)) {
    return [];
  }
  const callee = expressions.unwrapExpression(node.expression);
  const library = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : "";
  const key = node.arguments[1] && expressions.unwrapExpression(node.arguments[1]);
  if (key && ts.isStringLiteralLike(key) && DEFINERS.has(library)) {
    return [key.text];
  }
  return library === "Object.assign"
    ? node.arguments.slice(1).flatMap((source) => {
      const value = expressions.unwrapExpression(source);
      return ts.isObjectLiteralExpression(value) ? value.properties.flatMap((property) => declarationName(property) ?? []) : [];
    })
    : [];
}

// A computed name other than a literal or a symbol can be any member name.
export function openName(member: ts.Node): boolean {
  const name = (member as { name?: ts.Node }).name;
  if (!name || !ts.isComputedPropertyName(name)) {
    return false;
  }
  const key = expressions.unwrapExpression(name.expression);
  const symbol = ts.isPropertyAccessExpression(key) && ts.isIdentifier(key.expression) && key.expression.text === "Symbol";
  return !symbol && literalName(key) === undefined;
}

export function declarationName(node: ts.Node): string | undefined {
  if (!ts.isMethodDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node) &&
      !ts.isPropertyDeclaration(node) && !ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
    return undefined;
  }
  const name = node.name;
  return ts.isComputedPropertyName(name) ? literalName(expressions.unwrapExpression(name.expression)) : keyName(name);
}

/** Gives the member name a plain or literal key spells, as add for add, "add", and { add: x }. */
export function keyName(key: ts.Node): string | undefined {
  return ts.isIdentifier(key) ? key.text : literalName(key);
}

/** Gives the value a property member holds, as x for { add: x }, { x }, and a field initializer. */
export function memberValue(member: ts.Node): ts.Expression | undefined {
  if (ts.isShorthandPropertyAssignment(member)) {
    return member.name;
  }
  return ts.isPropertyDeclaration(member) || ts.isPropertyAssignment(member) ? member.initializer : undefined;
}

function literalName(name: ts.Node): string | undefined {
  return ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}
