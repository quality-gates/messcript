// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { declarationName, methodName, unwrapExpression } from "./expressions";
import { isFunctionLike } from "./functions";

export type ScopeKind = "file" | "namespace" | "function" | "class" | "block";

export type Scope = {
  readonly kind: ScopeKind;
  readonly node: ts.Node;
  readonly parent?: Scope;
};

export type DeclarationKind = "variable" | "parameter" | "function" | "class" | "enum" | "import";

export type Declaration = {
  readonly kind: DeclarationKind;
  readonly identifier: ts.Identifier;
  /** The node that declares the identifier, as a variable, parameter, function, class, enum, or import declaration. */
  readonly node: ts.Node;
};

export type Binding = {
  readonly name: string;
  readonly scope: Scope;
  readonly declarations: readonly Declaration[];
  readonly references: readonly ts.Identifier[];
  /** True when code writes the binding or its contents. The update clause of the loop that declares the binding does not count. */
  readonly mutated: boolean;
};

export type Write = {
  /** The write mutates the value's contents instead of replacing the root binding. */
  readonly contents: boolean;
  /** The write goes through a call result, as in f().x = 1. */
  readonly viaCall: boolean;
  /** The write replaces the value of the binding, as in x = 1. */
  readonly reassign: boolean;
  /** The write also reads the old value, as in x += 1. */
  readonly compound: boolean;
};

/** The lexical scopes of one source file, with each reference resolved to its binding. */
export type ScopeModel = {
  readonly bindings: readonly Binding[];
  /** Tells if the identifier refers to a value or a type, and is not a declaration name, property name, or label. */
  isReference(identifier: ts.Identifier): boolean;
  resolve(identifier: ts.Identifier): Binding | undefined;
  /** Resolves a local type alias or a declaration that shadows a host type name. */
  resolveType(identifier: ts.Identifier): LocalType | undefined;
  /** Gives the write to the root identifier or "this" of a write target, as "a" in a.b = 1 or a.push(1). */
  writeOf(node: ts.Node): Write | undefined;
  /** Tells if the file assigns, updates, or deletes the member access, as a.b in a.b = 1. */
  writesMember(access: ts.Node): boolean;
  /** Tells if the file writes or defines a member of the name, as add in o.add = f, Object.defineProperty(o, "add", d), or Object.defineProperties(o, { add: d }). */
  writesMemberName(name: string): boolean;
};

type MutableBinding = {
  name: string;
  scope: Scope;
  declarations: Declaration[];
  references: ts.Identifier[];
  mutated: boolean;
};

const mutatingMethods = new Set([
  "add", "append", "appendChild", "clear", "copyWithin", "delete", "fill", "insertBefore", "pop", "prepend", "push",
  "remove", "removeAttribute", "removeChild", "removeItem", "replaceChildren", "reverse", "set", "setAttribute",
  "setItem", "shift", "sort", "splice", "unshift", "write", "writeln",
]);

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingIdentifiers(element.name) : []));
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function scopeKindOf(node: ts.Node): ScopeKind | undefined {
  if (isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) {
    return "function";
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return "class";
  }
  if (ts.isModuleBlock(node) && (node.parent.flags & ts.NodeFlags.GlobalAugmentation) === 0) {
    return "namespace";
  }
  const block = ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node) ||
    ts.isForInStatement(node) || ts.isForOfStatement(node);
  return block ? "block" : undefined;
}

function isExportedLocal(identifier: ts.Identifier, specifier: ts.ExportSpecifier): boolean {
  return specifier.parent.parent.moduleSpecifier === undefined && (specifier.propertyName ?? specifier.name) === identifier;
}

function isReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  // A shorthand property reads its name and its default value.
  if (ts.isShorthandPropertyAssignment(parent)) {
    return true;
  }
  if (ts.isExportSpecifier(parent)) {
    return isExportedLocal(identifier, parent);
  }
  if (ts.isQualifiedName(parent)) {
    return parent.left === identifier;
  }
  const named = "name" in parent && parent.name === identifier;
  const propertyName = "propertyName" in parent && parent.propertyName === identifier;
  const label = "label" in parent && parent.label === identifier;
  return !named && !propertyName && !label;
}

/** Tells if a declare modifier or a declaration file leaves the node to code outside the file. */
export function isAmbient(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.canHaveModifiers(current) && ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      return true;
    }
  }
  return node.getSourceFile().isDeclarationFile;
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function assignmentTargets(node: ts.Expression): ts.Expression[] {
  const target = unwrapExpression(node);
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) => assignmentTargets(ts.isSpreadElement(element) ? element.expression : element));
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name];
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargets(property.initializer);
      }
      return ts.isSpreadAssignment(property) ? assignmentTargets(property.expression) : [];
    });
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargets(target.left);
  }
  return ts.isOmittedExpression(target) ? [] : [target];
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isUpdateExpression(node: ts.Node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken);
}

/** Gives the expressions the node assigns, updates, or deletes. */
export function writeTargets(node: ts.Node): ts.Expression[] {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return assignmentTargets(node.left);
  }
  if (isUpdateExpression(node)) {
    return [node.operand];
  }
  if (ts.isDeleteExpression(node)) {
    return [node.expression];
  }
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
    return assignmentTargets(node.initializer);
  }
  return [];
}

function contentWriteTargets(node: ts.Node): ts.Expression[] {
  if (!ts.isCallExpression(node)) {
    return [];
  }
  const callee = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return [];
  }
  const receiver = unwrapExpression(callee.expression);
  const name = methodName(callee);
  if (ts.isIdentifier(receiver) && receiver.text === "Object" && name === "assign") {
    return node.arguments.slice(0, 1);
  }
  return name && mutatingMethods.has(name) ? [receiver] : [];
}

// A compound write such as "x += 1" or "x++" also reads the old value.
function isCompoundWrite(node: ts.Node): boolean {
  return ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken);
}

// Each iteration of a loop gets a new binding, so the update clause does not change state that a closure can see.
function isLoopUpdateWrite(target: ts.Node, binding: MutableBinding): boolean {
  const loop = binding.scope.node;
  if (!ts.isForStatement(loop) || !loop.incrementor || !isInside(target, loop.incrementor)) {
    return false;
  }
  for (let current: ts.Node = target; current !== loop.incrementor; current = current.parent) {
    if (isFunctionLike(current)) {
      return false;
    }
  }
  return true;
}

function isVarDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0;
}

function hoistingScope(scope: Scope): Scope {
  let current = scope;
  while (current.parent && current.kind !== "function" && current.kind !== "namespace") {
    current = current.parent;
  }
  return current;
}

// messcript-disable-next-line CyclomaticComplexity
function declaredName(node: ts.Node): ts.Identifier | undefined {
  const name = (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) || ts.isEnumDeclaration(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) ||
      ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node))
    ? node.name
    : undefined;
  return name && ts.isIdentifier(name) ? name : undefined;
}

function declarationKind(node: ts.Node): DeclarationKind {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return "function";
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return "class";
  }
  return ts.isEnumDeclaration(node) ? "enum" : "import";
}

// The for-in or for-of expression runs before the loop bindings exist.
function isOuterChild(node: ts.Node, child: ts.Node): boolean {
  return (ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.expression === child;
}

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

function visitReachableChildren(node: ts.Node, scope: Scope, visit: (node: ts.Node, scope: Scope) => void): boolean {
  if (ts.isIfStatement(node)) {
    visit(node.expression, scope);
    const condition = literalBooleanValue(node.expression);
    if (condition === true) {
      visit(node.thenStatement, scope);
    } else if (condition === false) {
      if (node.elseStatement) {
        visit(node.elseStatement, scope);
      }
    } else {
      visit(node.thenStatement, scope);
      if (node.elseStatement) {
        visit(node.elseStatement, scope);
      }
    }
    return true;
  }
  if (ts.isConditionalExpression(node)) {
    visit(node.condition, scope);
    const condition = literalBooleanValue(node.condition);
    if (condition === true) {
      visit(node.whenTrue, scope);
    } else if (condition === false) {
      visit(node.whenFalse, scope);
    } else {
      visit(node.whenTrue, scope);
      visit(node.whenFalse, scope);
    }
    return true;
  }
  return false;
}

class ScopeBuilder {
  readonly bindings: MutableBinding[] = [];
  readonly resolved = new Map<ts.Identifier, MutableBinding | undefined>();
  readonly writes = new Map<ts.Node, Write>();
  private readonly bindingsByScope = new Map<Scope, Map<string, MutableBinding>>();
  private readonly references: Array<[ts.Identifier, Scope]> = [];

  build(sourceFile: ts.SourceFile): void {
    this.visit(sourceFile, { kind: "file", node: sourceFile });
    for (const [identifier, scope] of this.references) {
      const binding = this.lookup(scope, identifier.text);
      binding?.references.push(identifier);
      this.resolved.set(identifier, binding);
    }
    this.markMutations();
  }

  private declare(scope: Scope, identifier: ts.Identifier, kind: DeclarationKind, node: ts.Node): void {
    const bindings = this.bindingsByScope.get(scope) ?? new Map<string, MutableBinding>();
    this.bindingsByScope.set(scope, bindings);
    let binding = bindings.get(identifier.text);
    if (!binding) {
      binding = { name: identifier.text, scope, declarations: [], references: [], mutated: false };
      bindings.set(identifier.text, binding);
      this.bindings.push(binding);
    }
    binding.declarations.push({ kind, identifier, node });
  }

  private lookup(scope: Scope, name: string): MutableBinding | undefined {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const binding = this.bindingsByScope.get(current)?.get(name);
      if (binding) {
        return binding;
      }
    }
    return undefined;
  }

  // A named function expression or class expression binds its name inside its own scope.
  // messcript-disable-next-line CyclomaticComplexity
  private declareNames(node: ts.Node, outer: Scope, inner: Scope): void {
    if (ts.isVariableDeclaration(node)) {
      const scope = isVarDeclaration(node) ? hoistingScope(outer) : outer;
      for (const identifier of bindingIdentifiers(node.name)) {
        this.declare(scope, identifier, "variable", node);
      }
    } else if (ts.isParameter(node) && isFunctionLike(node.parent)) {
      for (const identifier of bindingIdentifiers(node.name)) {
        this.declare(outer, identifier, "parameter", node);
      }
    } else {
      const name = declaredName(node);
      const own = ts.isFunctionExpression(node) || ts.isClassExpression(node);
      if (name) {
        this.declare(own ? inner : outer, name, declarationKind(node), node);
      }
    }
  }

  private visit(node: ts.Node, scope: Scope): void {
    this.recordWrites(node);
    if (ts.isIdentifier(node)) {
      if (isReference(node)) {
        this.references.push([node, scope]);
      }
      return;
    }
    const kind = scopeKindOf(node);
    const inner = kind ? { kind, node, parent: scope } : scope;
    this.declareNames(node, scope, inner);
    if (visitReachableChildren(node, inner, (child, childScope) => this.visit(child, childScope))) {
      return;
    }
    ts.forEachChild(node, (child) => this.visit(child, isOuterChild(node, child) ? scope : inner));
  }

  private recordWrites(node: ts.Node): void {
    for (const target of writeTargets(node)) {
      this.recordWrite(target, false, isCompoundWrite(node));
    }
    for (const target of contentWriteTargets(node)) {
      this.recordWrite(target, true, false);
    }
  }

  private recordWrite(target: ts.Expression, contentsOnly: boolean, compound: boolean): void {
    let current = unwrapExpression(target);
    const reassign = !contentsOnly && ts.isIdentifier(current);
    let viaCall = false;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current)) {
      viaCall ||= ts.isCallExpression(current);
      current = unwrapExpression(current.expression);
    }
    if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) {
      this.writes.set(current, { contents: contentsOnly, viaCall, reassign, compound });
    }
  }

  private markMutations(): void {
    for (const [node, write] of this.writes) {
      const binding = ts.isIdentifier(node) ? this.resolved.get(node) : undefined;
      if (binding && !write.viaCall && !isLoopUpdateWrite(node, binding)) {
        binding.mutated = true;
      }
    }
  }
}

type MemberWrites = { readonly targets: ReadonlySet<ts.Node>; readonly names: ReadonlySet<string>; readonly anyName: boolean };

const definingCalls = new Set(["Object.defineProperty", "Reflect.defineProperty", "Reflect.set"]);
const patchingCalls = new Set([...definingCalls, "Object.defineProperties", "Object.assign"]);

function memberWrites(sourceFile: ts.SourceFile): MemberWrites {
  const targets = new Set<ts.Node>();
  const names = new Set<string>();
  let anyName = false;
  const visit = (node: ts.Node): void => {
    for (const target of writeTargets(node)) {
      const value = unwrapExpression(target);
      targets.add(value);
      const name = methodName(value);
      if (name !== undefined) {
        names.add(name);
      }
      anyName ||= writesPrototypeKey(value);
    }
    const defined = definedNames(node);
    anyName ||= defined === undefined || aliasesPatchingCall(node);
    for (const name of defined ?? []) {
      names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { targets, names, anyName };
}

/** Tells if the write patches a prototype under a key no literal spells, as p in Api.prototype[p] = f. */
function writesPrototypeKey(target: ts.Expression): boolean {
  if (!ts.isElementAccessExpression(target) || methodName(target) !== undefined) {
    return false;
  }
  const owner = unwrapExpression(target.expression);
  return ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype";
}

/** Tells if the node takes a patching call as a value, as const define = Object.defineProperty or { assign } = Object. */
function aliasesPatchingCall(node: ts.Node): boolean {
  if (ts.isBindingElement(node)) {
    return destructuresPatchingCall(node);
  }
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && patchingCalls.has(libraryName(node)) && !isCallee(node);
}

function destructuresPatchingCall(element: ts.BindingElement): boolean {
  const declaration = element.parent.parent;
  const source = ts.isVariableDeclaration(declaration) && declaration.initializer && unwrapExpression(declaration.initializer);
  const key = element.propertyName ?? element.name;
  return !!source && ts.isIdentifier(source) && ts.isIdentifier(key) && patchingCalls.has(`${source.text}.${key.text}`);
}

/** Gives the spelled library member, as Object.assign for Object.assign and Object["assign"], or "" for other receivers. */
function libraryName(member: ts.PropertyAccessExpression | ts.ElementAccessExpression): string {
  const receiver = unwrapExpression(member.expression);
  return ts.isIdentifier(receiver) ? `${receiver.text}.${methodName(member)}` : "";
}

/** Tells if the expression, through parentheses and type assertions, is the callee of a call. */
function isCallee(expression: ts.Expression): boolean {
  let top: ts.Node = expression;
  while (ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent) || ts.isNonNullExpression(top.parent) ||
      ts.isTypeAssertionExpression(top.parent) || ts.isSatisfiesExpression(top.parent)) {
    top = top.parent;
  }
  return ts.isCallExpression(top.parent) && top.parent.expression === top;
}

function definedNames(node: ts.Node): string[] | undefined {
  if (!ts.isCallExpression(node)) {
    return [];
  }
  const callee = unwrapExpression(node.expression);
  const library = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? libraryName(callee) : "";
  const target = node.arguments[0] && unwrapExpression(node.arguments[0]);
  return target && !ts.isObjectLiteralExpression(target) ? libraryNames(library, node.arguments) : [];
}

function libraryNames(library: string, args: readonly ts.Expression[]): string[] | undefined {
  if (definingCalls.has(library)) {
    const key = args[1] && unwrapExpression(args[1]);
    return key && ts.isStringLiteralLike(key) ? [key.text] : undefined;
  }
  if (library === "Object.defineProperties") {
    return sourceNames(args.slice(1, 2));
  }
  return library === "Object.assign" ? sourceNames(args.slice(1)) : [];
}

function sourceNames(sources: readonly ts.Expression[]): string[] | undefined {
  const names: string[] = [];
  for (const source of sources) {
    const value = unwrapExpression(source);
    const properties = ts.isObjectLiteralExpression(value) ? value.properties.map(declarationName) : [undefined];
    if (properties.some((name) => name === undefined)) {
      return undefined;
    }
    names.push(...properties as string[]);
  }
  return names;
}

// messcript-disable-next-line GlobalVariable
const modelCache = new WeakMap<ts.SourceFile, ScopeModel>();

function buildModel(sourceFile: ts.SourceFile): ScopeModel {
  const builder = new ScopeBuilder();
  builder.build(sourceFile);
  let members: MemberWrites | undefined;
  const writes = (): MemberWrites => (members ??= memberWrites(sourceFile));
  return {
    bindings: builder.bindings,
    isReference: (identifier) => builder.resolved.has(identifier),
    resolve: (identifier) => builder.resolved.get(identifier),
    resolveType: resolveLocalType,
    writeOf: (node) => builder.writes.get(node),
    writesMember: (access) => writes().targets.has(access),
    writesMemberName: (name) => writes().anyName || writes().names.has(name),
  };
}

/**
 * Builds the lexical scopes of a source file in one pass.
 * It binds each declaration to its scope, resolves each reference to its binding, and classifies each write.
 * A var declaration belongs to the nearest function, namespace, or file scope.
 * Other declarations belong to the nearest block scope.
 */
export function analyzeScopes(sourceFile: ts.SourceFile): ScopeModel {
  let model = modelCache.get(sourceFile);
  if (!model) {
    model = buildModel(sourceFile);
    modelCache.set(sourceFile, model);
  }
  return model;
}

type LocalType = { readonly kind: "alias"; readonly type: ts.TypeNode } | { readonly kind: "shadowed" };

function resolveLocalType(name: ts.Identifier): LocalType | undefined {
  for (let current: ts.Node | undefined = name.parent; current; current = current.parent) {
    const parameter = typeParameters(current)?.find((item) => item.name.text === name.text);
    const declaration = blockTypeDeclaration(current, name.text);
    if (parameter || declaration) {
      return declaration && ts.isTypeAliasDeclaration(declaration)
        ? { kind: "alias", type: declaration.type } : { kind: "shadowed" };
    }
  }
  return undefined;
}

function typeParameters(node: ts.Node): readonly ts.TypeParameterDeclaration[] | undefined {
  return ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    ? node.typeParameters : undefined;
}

function blockTypeDeclaration(node: ts.Node, name: string): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  if (!ts.isBlock(node) && !ts.isSourceFile(node) && !ts.isModuleBlock(node)) {
    return undefined;
  }
  return node.statements.find((statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
    (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === name);
}
