// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { getClassFields, getClassMethods, isParameterProperty } from "../ast/classes";
import type { ClassField, ClassLike, ClassMethod } from "../ast/classes";
import { unwrapExpression } from "../ast/expressions";
import { analyzeScopes } from "../ast/scopes";
import type { Binding, Declaration } from "../ast/scopes";
import { walkAst } from "../ast/walk";

export type UnusedKind = "privateField" | "privateMethod" | "local" | "formal";

export type UnusedDeclaration = {
  name: string;
  node: ts.Node;
  kind: UnusedKind;
  context: string;
  used: boolean;
  uncertain?: boolean;
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
  if (ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name)) {
    return node.name.text;
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

function isLocalScope(binding: Binding): boolean {
  return binding.scope.kind !== "file" && binding.scope.kind !== "namespace";
}

function isFormalParameter(declaration: Declaration): boolean {
  const parameter = declaration.node;
  if (!ts.isParameter(parameter) || !ts.isFunctionLike(parameter.parent) || !("body" in parameter.parent) || !parameter.parent.body) {
    return false;
  }
  return !ts.isConstructorDeclaration(parameter.parent) || !isParameterProperty(parameter);
}

function bindingDeclaration(binding: Binding, declaration: Declaration): UnusedDeclaration | undefined {
  const node = declaration.node;
  const used = binding.references.length > 0;
  const name = declaration.identifier.text;
  if (ts.isVariableDeclaration(node) && isLocalScope(binding)) {
    return { name, node: declaration.identifier, kind: "local", context: `local variable ${node.name.getText()}`, used };
  }
  if (ts.isParameter(node) && isFormalParameter(declaration)) {
    return { name, node: declaration.identifier, kind: "formal", context: `formal parameter ${node.name.getText()}`, used };
  }
  return undefined;
}

// A class expression without a name takes the name of the variable that holds it.
function className(node: ClassLike): string | undefined {
  const parent = node.parent;
  if (node.name) {
    return node.name.text;
  }
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined;
}

function isWriteOnly(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function isThis(node: ts.Expression): boolean {
  return unwrapExpression(node).kind === ts.SyntaxKind.ThisKeyword;
}

// messcript-disable-next-line ExcessiveClassComplexity
class UnusedAnalyzer {
  private readonly declarations: UnusedDeclaration[] = [];
  private readonly classesByNode = new Map<ts.Node, ClassInfo>();
  private readonly classesByName = new Map<string, ClassInfo>();

  analyze(sourceFile: ts.SourceFile): UnusedDeclaration[] {
    for (const binding of analyzeScopes(sourceFile).bindings) {
      for (const declaration of binding.declarations) {
        const unused = bindingDeclaration(binding, declaration);
        if (unused) {
          this.declarations.push(unused);
        }
      }
    }
    walkAst(sourceFile, (node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        this.collectClass(node);
      }
    });
    walkAst(sourceFile, (node) => {
      this.markMemberUses(node);
    });
    return this.declarations.sort((first, second) => first.node.pos - second.node.pos);
  }

  private collectClass(node: ClassLike): void {
    const name = className(node);
    const classInfo: ClassInfo = { name, privateMembers: new Map() };
    this.classesByNode.set(node, classInfo);
    if (name) {
      this.classesByName.set(name, classInfo);
    }
    if (!hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
      this.collectMembers(node, classInfo);
    }
  }

  private collectMembers(node: ClassLike, classInfo: ClassInfo): void {
    for (const field of getClassFields(node)) {
      if (isPrivateMember(field)) {
        this.addMember(classInfo, field, "privateField");
      }
    }
    for (const method of getClassMethods(node)) {
      if (isPrivateMember(method) && method.body && !ts.isConstructorDeclaration(method)) {
        this.addMember(classInfo, method, "privateMethod");
      }
    }
  }

  private addMember(classInfo: ClassInfo, member: ClassField | ClassMethod, kind: "privateField" | "privateMethod"): void {
    const name = nameText(member, member.getSourceFile());
    if (!name) {
      return;
    }
    const context = kind === "privateField" ? `private field ${name}` : `private method ${name}()`;
    const declaration: UnusedDeclaration = { name, node: member, kind, context, used: false };
    const members = classInfo.privateMembers.get(memberKey(name)) ?? [];
    members.push(declaration);
    classInfo.privateMembers.set(memberKey(name), members);
    this.declarations.push(declaration);
  }

  private currentClass(node: ts.Node): ClassInfo | undefined {
    for (let current = node.parent; current; current = current.parent) {
      const classInfo = this.classesByNode.get(current);
      if (classInfo) {
        return classInfo;
      }
    }
    return undefined;
  }

  private markPrivate(name: string, node: ts.Node, classInfo = this.currentClass(node)): void {
    if (isWriteOnly(node)) {
      return;
    }
    for (const member of classInfo?.privateMembers.get(memberKey(name)) ?? []) {
      member.used = true;
    }
  }

  private markClassUncertain(classInfo: ClassInfo | undefined): void {
    for (const members of classInfo?.privateMembers.values() ?? []) {
      for (const member of members) {
        member.uncertain = true;
      }
    }
  }

  private markMemberUses(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) {
      this.markPropertyAccess(node);
    } else if (ts.isElementAccessExpression(node)) {
      this.markElementAccess(node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      this.markThisAssignment(node);
    } else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      this.markThisDestructuring(node.name, node.initializer);
    }
  }

  private markPropertyAccess(node: ts.PropertyAccessExpression): void {
    const receiver = unwrapExpression(node.expression);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      this.markPrivate(node.name.text, node);
    } else if (ts.isIdentifier(receiver)) {
      this.markPrivate(node.name.text, node, this.classesByName.get(receiver.text));
    }
  }

  private markElementAccess(node: ts.ElementAccessExpression): void {
    if (!isThis(node.expression)) {
      return;
    }
    const key = unwrapExpression(node.argumentExpression);
    if (ts.isStringLiteralLike(key)) {
      this.markPrivate(key.text, node);
    } else {
      this.markClassUncertain(this.currentClass(node));
    }
  }

  private markThisAssignment(node: ts.BinaryExpression): void {
    const left = unwrapExpression(node.left);
    if (!isThis(node.right) || !ts.isObjectLiteralExpression(left)) {
      return;
    }
    for (const property of left.properties) {
      if (ts.isShorthandPropertyAssignment(property) || (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))) {
        this.markPrivate(property.name.getText(), property);
      }
    }
  }

  private markThisDestructuring(pattern: ts.BindingName, initializer: ts.Expression | undefined): void {
    if (!initializer || !ts.isObjectBindingPattern(pattern) || !isThis(initializer)) {
      return;
    }
    for (const element of pattern.elements) {
      const memberName = element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name)
        ? element.name.text
        : undefined;
      if (memberName) {
        this.markPrivate(memberName, element);
      }
    }
  }
}

// messcript-disable-next-line GlobalVariable ConstantNamingConventions
const unusedCache = new WeakMap<ts.SourceFile, readonly UnusedDeclaration[]>();

export function analyzeUnused(sourceFile: ts.SourceFile): readonly UnusedDeclaration[] {
  let result = unusedCache.get(sourceFile);
  if (!result) {
    result = new UnusedAnalyzer().analyze(sourceFile);
    unusedCache.set(sourceFile, result);
  }
  return result;
}

