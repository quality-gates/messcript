import ts from "typescript";
import { getClassFields, getClassMethods } from "../ast/classes";
import type { ClassField, ClassLike, ClassMethod } from "../ast/classes";
import { isFunctionLike } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";

export type UnusedKind = "privateField" | "privateMethod" | "local" | "formal";

export type UnusedDeclaration = {
  name: string;
  node: ts.Node;
  kind: UnusedKind;
  context: string;
  used: boolean;
};

type Scope = {
  parent?: Scope;
  bindings: Map<string, Binding[]>;
  classInfo?: ClassInfo;
  root: boolean;
};

type Binding = {
  name: string;
  node: ts.Node;
  declaration?: UnusedDeclaration;
};

type ClassInfo = {
  name?: string;
  privateMembers: Map<string, UnusedDeclaration[]>;
};

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: readonly ts.Modifier[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function nameText(node: ClassField | ClassMethod, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isParameter(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (!node.name || ts.isComputedPropertyName(node.name)) {
    return undefined;
  }
  return node.name.getText(sourceFile);
}

function memberKey(name: string): string {
  return name.replace(/^#/, "");
}

function isPrivateMember(node: ClassField | ClassMethod): boolean {
  if ("name" in node && node.name && ts.isPrivateIdentifier(node.name)) {
    return true;
  }
  return hasModifier(node, ts.SyntaxKind.PrivateKeyword);
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  const identifiers: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      identifiers.push(...bindingIdentifiers(element.name));
    }
  }
  return identifiers;
}

function bindingName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPrivateIdentifier(node)) {
    return node.text.replace(/^#/, "");
  }
  return undefined;
}

function isParameterProperty(node: ts.ParameterDeclaration): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.PublicKeyword) ||
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword) ||
    hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)
  );
}

class UnusedAnalyzer {
  private readonly root: Scope = { bindings: new Map(), root: true };
  private readonly scopeByNode = new Map<ts.Node, Scope>();
  private readonly declarationNodes = new Set<ts.Node>();
  private readonly declarations: UnusedDeclaration[] = [];
  private readonly classesByName = new Map<string, ClassInfo>();

  analyze(sourceFile: ts.SourceFile): UnusedDeclaration[] {
    this.build(sourceFile, this.root);
    this.visitReferences(sourceFile);
    return this.declarations;
  }

  private addBinding(scope: Scope, name: string, node: ts.Node, declaration?: UnusedDeclaration): void {
    const bindings = scope.bindings.get(name) ?? [];
    bindings.push({ name, node, declaration });
    scope.bindings.set(name, bindings);
    this.declarationNodes.add(node);
    if (declaration) {
      this.declarations.push(declaration);
    }
  }

  private addBindingName(scope: Scope, name: ts.BindingName, kind: UnusedKind | undefined, context: string): void {
    for (const identifier of bindingIdentifiers(name)) {
      const declaration = kind
        ? { name: identifier.text, node: identifier, kind, context, used: false }
        : undefined;
      this.addBinding(scope, identifier.text, identifier, declaration);
    }
  }

  private currentClass(scope: Scope | undefined): ClassInfo | undefined {
    let current = scope;
    while (current) {
      if (current.classInfo) {
        return current.classInfo;
      }
      current = current.parent;
    }
    return undefined;
  }

  private isLocalScope(scope: Scope): boolean {
    return !scope.root;
  }

  private buildClass(node: ClassLike, parent: Scope): void {
    const className = node.name?.text ??
      (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined);
    const classInfo: ClassInfo = { name: className, privateMembers: new Map() };
    if (className) {
      this.classesByName.set(className, classInfo);
    }
    const classScope: Scope = { parent, bindings: new Map(), classInfo, root: false };
    this.scopeByNode.set(node, parent);
    if (ts.isClassDeclaration(node) && node.name) {
      this.addBinding(parent, node.name.text, node.name);
    }

    const declarationOnly = hasModifier(node, ts.SyntaxKind.DeclareKeyword);
    for (const field of getClassFields(node)) {
      if (declarationOnly || !isPrivateMember(field)) {
        continue;
      }
      const name = nameText(field, node.getSourceFile());
      if (!name) {
        continue;
      }
      const declaration: UnusedDeclaration = {
        name,
        node: field,
        kind: "privateField",
        context: `private field ${name}`,
        used: false,
      };
      const members = classInfo.privateMembers.get(memberKey(name)) ?? [];
      members.push(declaration);
      classInfo.privateMembers.set(memberKey(name), members);
      this.declarations.push(declaration);
      this.markMemberDeclaration(field);
    }
    for (const method of getClassMethods(node)) {
      if (declarationOnly || !isPrivateMember(method) || !method.body || ts.isConstructorDeclaration(method)) {
        continue;
      }
      const name = nameText(method, node.getSourceFile());
      if (!name) {
        continue;
      }
      const declaration: UnusedDeclaration = {
        name,
        node: method,
        kind: "privateMethod",
        context: `private method ${name}()`,
        used: false,
      };
      const members = classInfo.privateMembers.get(memberKey(name)) ?? [];
      members.push(declaration);
      classInfo.privateMembers.set(memberKey(name), members);
      this.declarations.push(declaration);
      this.markMemberDeclaration(method);
    }

    for (const child of node.members) {
      this.build(child, classScope);
    }
  }

  private markMemberDeclaration(node: ClassField | ClassMethod): void {
    if ("name" in node && node.name) {
      this.declarationNodes.add(node.name);
    }
  }

  private buildFunction(node: FunctionLike, parent: Scope): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      this.addBinding(parent, node.name.text, node.name);
    }
    const functionScope: Scope = { parent, bindings: new Map(), root: false };
    this.scopeByNode.set(node, functionScope);
    if (node.name) {
      this.declarationNodes.add(node.name);
    }
    for (const parameter of node.parameters) {
      const parameterProperty = ts.isConstructorDeclaration(node) && isParameterProperty(parameter);
      this.addBindingName(
        functionScope,
        parameter.name,
        node.body && !parameterProperty ? "formal" : undefined,
        `formal parameter ${parameter.name.getText()}`,
      );
      this.build(parameter, functionScope);
    }
    if (node.body) {
      this.build(node.body, functionScope);
    }
  }

  private build(node: ts.Node, scope: Scope): void {
    this.scopeByNode.set(node, scope);
    if (ts.isSourceFile(node)) {
      for (const child of node.statements) {
        this.build(child, scope);
      }
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      this.buildClass(node, scope);
      return;
    }
    if (isFunctionLike(node)) {
      this.buildFunction(node, scope);
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope: Scope = { parent: scope, bindings: new Map(), root: false };
      this.scopeByNode.set(node, blockScope);
      for (const child of node.statements) {
        this.build(child, blockScope);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      this.addBindingName(scope, node.name, this.isLocalScope(scope) ? "local" : undefined, `local variable ${node.name.getText()}`);
      if (node.type) {
        this.build(node.type, scope);
      }
      if (node.initializer) {
        this.build(node.initializer, scope);
      }
      return;
    }
    if (ts.isParameter(node)) {
      if (node.type) {
        this.build(node.type, scope);
      }
      if (node.initializer) {
        this.build(node.initializer, scope);
      }
      return;
    }
    if (ts.isBindingElement(node)) {
      if (node.propertyName) {
        this.build(node.propertyName, scope);
      }
      if (node.initializer) {
        this.build(node.initializer, scope);
      }
      return;
    }
    if (ts.isPropertyDeclaration(node)) {
      if (node.type) {
        this.build(node.type, scope);
      }
      if (node.initializer) {
        this.build(node.initializer, scope);
      }
      return;
    }
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      this.buildFunction(node, scope);
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: Scope = { parent: scope, bindings: new Map(), root: false };
      this.scopeByNode.set(node, catchScope);
      if (node.variableDeclaration) {
        this.build(node.variableDeclaration, catchScope);
      }
      this.build(node.block, catchScope);
      return;
    }
    ts.forEachChild(node, (child) => this.build(child, scope));
  }

  private resolve(scope: Scope | undefined, name: string): Binding | undefined {
    let current = scope;
    while (current) {
      const bindings = current.bindings.get(name);
      if (bindings && bindings.length > 0) {
        return bindings[bindings.length - 1];
      }
      current = current.parent;
    }
    return undefined;
  }

  private isWriteOnly(node: ts.Node): boolean {
    const parent = node.parent;
    return ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }

  private markPrivate(scope: Scope, name: string, node: ts.Node, classInfo = this.currentClass(scope)): void {
    if (this.isWriteOnly(node)) {
      return;
    }
    const members = classInfo?.privateMembers.get(memberKey(name));
    for (const member of members ?? []) {
      member.used = true;
    }
  }

  private visitFunction(node: FunctionLike): void {
    if (node.type) {
      this.visitReferences(node.type);
    }
    for (const parameter of node.parameters) {
      this.visitReferences(parameter);
    }
    if (node.body) {
      this.visitReferences(node.body);
    }
  }

  private visitReferences(node: ts.Node): void {
    const scope = this.scopeByNode.get(node) ?? this.root;
    if (ts.isPropertyAccessExpression(node)) {
      this.visitReferences(node.expression);
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        this.markPrivate(scope, node.name.getText(), node);
      } else if (ts.isIdentifier(node.expression)) {
        this.markPrivate(scope, node.name.getText(), node, this.classesByName.get(node.expression.text));
      }
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      this.visitReferences(node.expression);
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
        this.markPrivate(scope, node.argumentExpression.text, node);
      }
      if (node.argumentExpression) {
        this.visitReferences(node.argumentExpression);
      }
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const child of node.members) {
        this.visitReferences(child);
      }
      return;
    }
    if (isFunctionLike(node)) {
      this.visitFunction(node);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.type) {
        this.visitReferences(node.type);
      }
      if (node.initializer) {
        this.visitReferences(node.initializer);
      }
      return;
    }
    if (ts.isParameter(node)) {
      if (node.type) {
        this.visitReferences(node.type);
      }
      if (node.initializer) {
        this.visitReferences(node.initializer);
      }
      return;
    }
    if (ts.isBindingElement(node)) {
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
        this.visitReferences(node.propertyName.expression);
      }
      if (node.initializer) {
        this.visitReferences(node.initializer);
      }
      return;
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (node.type) {
        this.visitReferences(node.type);
      }
      if (ts.isPropertyDeclaration(node) && node.initializer) {
        this.visitReferences(node.initializer);
      }
      return;
    }
    if (ts.isMethodSignature(node)) {
      for (const parameter of node.parameters) {
        this.visitReferences(parameter);
      }
      if (node.type) {
        this.visitReferences(node.type);
      }
      return;
    }
    if (ts.isQualifiedName(node)) {
      this.visitReferences(node.left);
      return;
    }
    if (ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) {
        this.visitReferences(node.name.expression);
      }
      this.visitReferences(node.initializer);
      return;
    }
    if (ts.isTypeParameterDeclaration(node)) {
      if (node.constraint) {
        this.visitReferences(node.constraint);
      }
      if (node.default) {
        this.visitReferences(node.default);
      }
      return;
    }
    if (ts.isImportDeclaration(node)) {
      return;
    }
    if (ts.isIdentifier(node)) {
      if (this.declarationNodes.has(node)) {
        return;
      }
      const binding = this.resolve(scope, node.text);
      if (binding?.declaration) {
        binding.declaration.used = true;
      }
      return;
    }
    ts.forEachChild(node, (child) => this.visitReferences(child));
  }
}

export function analyzeUnused(sourceFile: ts.SourceFile): UnusedDeclaration[] {
  return new UnusedAnalyzer().analyze(sourceFile);
}
