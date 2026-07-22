import ts from "typescript";

export type ClassLike = ts.ClassDeclaration | ts.ClassExpression;

export type ClassMethod =
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

export type ClassField = ts.ParameterDeclaration | ts.PropertyDeclaration;

const ignoredMethodPattern = /^(set|get|is|has|with)/i;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: readonly ts.Modifier[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function hasAnyModifier(node: ts.Node, kinds: readonly ts.SyntaxKind[]): boolean {
  return kinds.some((kind) => hasModifier(node, kind));
}

function memberName(node: ClassMethod | ClassField, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isParameter(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if ("name" in node && node.name) {
    return node.name.getText(sourceFile);
  }
  return undefined;
}

function isParameterProperty(node: ts.ParameterDeclaration): boolean {
  return hasAnyModifier(node, [
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
  ]);
}

function sameMethodName(left: ClassMethod, right: ClassMethod, sourceFile: ts.SourceFile): boolean {
  return memberName(left, sourceFile) === memberName(right, sourceFile);
}

export function forEachClass(sourceFile: ts.SourceFile, callback: (node: ClassLike) => void): void {
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      callback(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function getClassContext(node: ClassLike, sourceFile: ts.SourceFile): string {
  let name = node.name?.getText(sourceFile);
  if (!name && ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    name = node.parent.name.text;
  }
  return `class ${name ?? "anonymous"}`;
}

export function getClassMethods(node: ClassLike): ClassMethod[] {
  const methods = node.members.filter(
    (member): member is ClassMethod =>
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isSetAccessorDeclaration(member),
  );

  return methods.filter((method, index) => {
    if (!ts.isMethodDeclaration(method) || method.body) {
      return true;
    }
    return !methods.slice(index + 1).some(
      (candidate) =>
        ts.isMethodDeclaration(candidate) && sameMethodName(method, candidate, node.getSourceFile()),
    );
  });
}

export function getClassFields(node: ClassLike): ClassField[] {
  const fields: ClassField[] = node.members.filter(
    (member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member),
  );
  const fieldNames = new Set(fields.map((field) => memberName(field, node.getSourceFile())));

  for (const member of node.members) {
    if (!ts.isConstructorDeclaration(member)) {
      continue;
    }
    for (const parameter of member.parameters) {
      if (!isParameterProperty(parameter)) {
        continue;
      }
      const name = memberName(parameter, node.getSourceFile());
      if (name && fieldNames.has(name)) {
        continue;
      }
      fields.push(parameter);
      if (name) {
        fieldNames.add(name);
      }
    }
  }

  return fields;
}

export function isPublicClassMember(node: ClassMethod | ClassField): boolean {
  if ("name" in node && node.name && ts.isPrivateIdentifier(node.name)) {
    return false;
  }
  return !hasAnyModifier(node, [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword]);
}

export function getClassMethodName(node: ClassMethod, sourceFile: ts.SourceFile): string | undefined {
  return memberName(node, sourceFile);
}

export function isIgnoredClassMethod(node: ClassMethod, sourceFile: ts.SourceFile): boolean {
  const name = getClassMethodName(node, sourceFile);
  return name !== undefined && ignoredMethodPattern.test(name);
}
