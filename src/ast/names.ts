// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { forEachFunctionLike, isFunctionLike } from "./functions";
import type { FunctionLike } from "./functions";
import { forEachClass, getClassContext } from "./classes";
import type { ClassField, ClassLike } from "./classes";

export type NamedBinding = {
  name: string;
  node: ts.Node;
  context: string;
};

export type NamedType = ClassLike | ts.InterfaceDeclaration;

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
    return node.text;
  }
  return undefined;
}

function addBinding(identifiers: NamedBinding[], node: ts.Node, context: string): void {
  const name = bindingName(node);
  if (name) {
    identifiers.push({ name, node, context });
  }
}

function addBindingName(identifiers: NamedBinding[], name: ts.BindingName, context: string): void {
  for (const identifier of bindingIdentifiers(name)) {
    addBinding(identifiers, identifier, context);
  }
}

function addFunctionParameters(identifiers: NamedBinding[], node: FunctionLike): void {
  for (const parameter of node.parameters) {
    addBindingName(identifiers, parameter.name, `parameter ${parameter.name.getText()}`);
  }
}

function addClassFields(identifiers: NamedBinding[], node: ClassLike, sourceFile: ts.SourceFile): void {
  for (const field of node.members) {
    if (ts.isPropertyDeclaration(field)) {
      addClassField(identifiers, field, sourceFile);
    }
    if (ts.isConstructorDeclaration(field)) {
      for (const parameter of field.parameters) {
        if (parameter.modifiers?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        )) {
          addBindingName(identifiers, parameter.name, `field ${parameter.name.getText(sourceFile)}`);
        }
      }
    }
  }
}

function addClassField(identifiers: NamedBinding[], field: ClassField, sourceFile: ts.SourceFile): void {
  if (ts.isPropertyDeclaration(field)) {
    const name = field.name;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      addBinding(identifiers, name, `field ${name.getText(sourceFile)}`);
    }
  }
}

function addPropertyName(identifiers: NamedBinding[], node: ts.PropertyDeclaration | ts.PropertySignature, sourceFile: ts.SourceFile): void {
  if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) {
    addBinding(identifiers, node.name, `property ${node.name.getText(sourceFile)}`);
  }
}

function addVariableDeclarations(identifiers: NamedBinding[], sourceFile: ts.SourceFile): void {
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      addBindingName(identifiers, node.name, `variable ${node.name.getText(sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function deduplicateBindings(bindings: readonly NamedBinding[], sourceFile: ts.SourceFile): NamedBinding[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.node.getStart(sourceFile)}:${binding.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function collectVariables(sourceFile: ts.SourceFile): NamedBinding[] {
  const variables: NamedBinding[] = [];
  addVariableDeclarations(variables, sourceFile);
  return deduplicateBindings(variables, sourceFile);
}

export function collectParameters(sourceFile: ts.SourceFile): NamedBinding[] {
  const parameters: NamedBinding[] = [];
  function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      addFunctionParameters(parameters, node);
    }
    if (
      ts.isMethodSignature(node) ||
      ts.isCallSignatureDeclaration(node) ||
      ts.isConstructSignatureDeclaration(node) ||
      ts.isFunctionTypeNode(node) ||
      ts.isConstructorTypeNode(node)
    ) {
      for (const parameter of node.parameters) {
        addBindingName(parameters, parameter.name, `parameter ${parameter.name.getText()}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return deduplicateBindings(parameters, sourceFile);
}

export function collectProperties(sourceFile: ts.SourceFile): NamedBinding[] {
  const properties: NamedBinding[] = [];
  forEachClass(sourceFile, (node) => addClassFields(properties, node, sourceFile));
  function visit(node: ts.Node): void {
    if (ts.isPropertySignature(node)) {
      addPropertyName(properties, node, sourceFile);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return deduplicateBindings(properties, sourceFile);
}

function addTypeParameters(identifiers: NamedBinding[], sourceFile: ts.SourceFile): void {
  function visit(node: ts.Node): void {
    const typeParameters = (node as ts.Node & { typeParameters?: ts.TypeParameterDeclaration[] }).typeParameters;
    if (typeParameters) {
      for (const parameter of typeParameters) {
        addBinding(identifiers, parameter.name, `type parameter ${parameter.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function collectBindings(sourceFile: ts.SourceFile): NamedBinding[] {
  const typeParameters: NamedBinding[] = [];
  addTypeParameters(typeParameters, sourceFile);
  return deduplicateBindings(
    [...collectVariables(sourceFile), ...collectParameters(sourceFile), ...collectProperties(sourceFile), ...typeParameters],
    sourceFile,
  );
}

function namedTypeName(node: NamedType, sourceFile: ts.SourceFile): string | undefined {
  if (node.name) {
    return node.name.getText(sourceFile);
  }
  if (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

export function forEachNamedType(sourceFile: ts.SourceFile, callback: (node: NamedType, name: string) => void): void {
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node)) {
      const name = namedTypeName(node, sourceFile);
      if (name) {
        callback(node, name);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function getNamedTypeContext(node: NamedType, sourceFile: ts.SourceFile): string {
  if (ts.isInterfaceDeclaration(node)) {
    return `interface ${node.name.text}`;
  }
  return getClassContext(node, sourceFile);
}

// messcript-disable-next-line CyclomaticComplexity
export function getFunctionBindingName(node: FunctionLike, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(node)) {
    return undefined;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    if (!node.name || ts.isComputedPropertyName(node.name)) {
      return undefined;
    }
    return bindingName(node.name);
  }
  if (node.name) {
    return bindingName(node.name);
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return bindingName(node.parent.name);
  }
  return undefined;
}

export function getNameWithoutSigil(name: string): string {
  return name.replace(/^[$#_]+/, "");
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
export function isReactComponentName(name: string, node: ts.Node): boolean {
  if (!/^[A-Z]/.test(name)) {
    return false;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return node.parent.initializer !== undefined &&
      (ts.isArrowFunction(node.parent.initializer) || ts.isFunctionExpression(node.parent.initializer) || ts.isClassExpression(node.parent.initializer));
  }
  if (ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent)) {
    return node.parent.initializer !== undefined &&
      (ts.isArrowFunction(node.parent.initializer) || ts.isFunctionExpression(node.parent.initializer) || ts.isClassExpression(node.parent.initializer));
  }
  if (ts.isVariableDeclaration(node)) {
    return node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isClassExpression(node.initializer));
  }
  return ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

export function collectSemanticConstants(sourceFile: ts.SourceFile): NamedBinding[] {
  const constants: NamedBinding[] = [];
  function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    const modifiers = (node as ts.Node & { modifiers?: readonly ts.Modifier[] }).modifiers;
    return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
  }
  // messcript-disable-next-line CyclomaticComplexity
  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node) && (node.parent === sourceFile || ts.isModuleBlock(node.parent))) {
      if ((node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const declaration of node.declarationList.declarations) {
          for (const identifier of bindingIdentifiers(declaration.name)) {
            addBinding(constants, identifier, `constant ${identifier.text}`);
          }
        }
      }
    }
    if (ts.isPropertyDeclaration(node) && hasModifier(node, ts.SyntaxKind.StaticKeyword) && hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)) {
      if (ts.isIdentifier(node.name)) {
        addBinding(constants, node.name, `constant ${node.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return constants;
}

export function collectBooleanReturns(body: ts.ConciseBody): ts.Expression[] {
  const returns: ts.Expression[] = [];
  if (!ts.isBlock(body)) {
    return [body];
  }

  function visit(node: ts.Node): void {
    if (node !== body && isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return returns;
}
