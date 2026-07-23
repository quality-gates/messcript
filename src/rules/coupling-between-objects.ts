// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { forEachClass, getClassContext } from "../ast/classes";
import type { ClassLike } from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";
import { createDesignFinding } from "./design-finding";

export const ruleName = "CouplingBetweenObjects";
export const priority = 2;
export const properties = { maximum: 13 } as const;

const builtinNames = new Set([
  "any", "bigint", "boolean", "never", "null", "number", "object", "string", "symbol", "undefined", "unknown", "void",
  "Array", "AsyncIterable", "BigInt", "Boolean", "Date", "Error", "Function", "Iterable", "Iterator", "Map", "Math", "Number",
  "Object", "Promise", "ReadonlyArray", "ReadonlyMap", "ReadonlySet", "Record", "RegExp", "Set", "String", "Symbol", "WeakMap",
  "WeakSet", "ConstructorParameters", "Exclude", "Extract", "InstanceType", "NonNullable", "Omit", "Partial", "Parameters",
  "Pick", "Required", "ReturnType", "ThisParameterType", "ThisType",
]);

function addDependency(dependencies: Set<string>, name: string, ownName?: string): void {
  const normalized = name.trim();
  if (!normalized || normalized === ownName) {
    return;
  }
  const base = normalized.split(".").at(-1) ?? normalized;
  if (builtinNames.has(normalized) || builtinNames.has(base)) {
    return;
  }
  dependencies.add(normalized);
}

function entityNameText(node: ts.EntityName | ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isQualifiedName(node) || ts.isPropertyAccessExpression(node)) {
    return node.getText(sourceFile);
  }
  return undefined;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function addImportDependencies(sourceFile: ts.SourceFile, dependencies: Set<string>): void {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const source = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const clause = statement.importClause;
      if (!clause) {
        if (source) {
          dependencies.add(`module:${source}`);
        }
        continue;
      }
      if (clause.name) {
        addDependency(dependencies, clause.name.text);
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          addDependency(dependencies, clause.namedBindings.name.text);
        } else {
          for (const specifier of clause.namedBindings.elements) {
            addDependency(dependencies, (specifier.propertyName ?? specifier.name).text);
          }
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const specifier of statement.exportClause.elements) {
            addDependency(dependencies, (specifier.propertyName ?? specifier.name).text);
          }
        } else {
          dependencies.add(`module:${statement.moduleSpecifier.text}`);
        }
      }
    }
  }
}

// messcript-disable-next-line CyclomaticComplexity
function collectTypeDependencies(node: ts.Node | undefined, sourceFile: ts.SourceFile, dependencies: Set<string>, ownName?: string): void {
  if (!node) {
    return;
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = entityNameText(node.typeName, sourceFile);
    if (name) {
      addDependency(dependencies, name, ownName);
    }
  } else if (ts.isExpressionWithTypeArguments(node)) {
    const name = entityNameText(node.expression, sourceFile);
    if (name) {
      addDependency(dependencies, name, ownName);
    }
  } else if (ts.isTypeQueryNode(node)) {
    const name = entityNameText(node.exprName, sourceFile);
    if (name) {
      addDependency(dependencies, name, ownName);
    }
  } else if (ts.isImportTypeNode(node)) {
    if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      dependencies.add(`module:${node.argument.literal.text}`);
    }
    if (node.qualifier) {
      addDependency(dependencies, node.qualifier.getText(sourceFile), ownName);
    }
  }
  ts.forEachChild(node, (child) => collectTypeDependencies(child, sourceFile, dependencies, ownName));
}

function collectExpressionDependencies(node: ts.Node | undefined, sourceFile: ts.SourceFile, dependencies: Set<string>, ownName?: string): void {
  if (!node) {
    return;
  }
  if (ts.isNewExpression(node)) {
    const name = entityNameText(node.expression, sourceFile);
    if (name) {
      addDependency(dependencies, name, ownName);
    }
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
    const argument = node.arguments[0];
    if (argument && ts.isStringLiteral(argument)) {
      dependencies.add(`module:${argument.text}`);
    }
  }
  ts.forEachChild(node, (child) => collectExpressionDependencies(child, sourceFile, dependencies, ownName));
}

function collectDecorators(node: ts.Node, sourceFile: ts.SourceFile, dependencies: Set<string>, ownName?: string): void {
  const getDecorators = ts.getDecorators as unknown as (node: ts.Node) => readonly ts.Decorator[] | undefined;
  for (const decorator of getDecorators(node) ?? []) {
    const name = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
    const text = entityNameText(name, sourceFile);
    if (text) {
      addDependency(dependencies, text, ownName);
    }
  }
}

function collectClassDependencies(node: ClassLike, sourceFile: ts.SourceFile): Set<string> {
  const dependencies = new Set<string>();
  const ownName = node.name?.text ?? (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined);
  addImportDependencies(sourceFile, dependencies);
  collectDecorators(node, sourceFile, dependencies, ownName);
  for (const heritage of node.heritageClauses ?? []) {
    collectTypeDependencies(heritage, sourceFile, dependencies, ownName);
  }
  // messcript-disable-next-line CyclomaticComplexity
  function visit(member: ts.Node): void {
    if (member !== node && (ts.isClassDeclaration(member) || ts.isClassExpression(member))) {
      return;
    }
    collectDecorators(member, sourceFile, dependencies, ownName);
    if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member) || ts.isParameter(member)) {
      collectTypeDependencies(member.type, sourceFile, dependencies, ownName);
      if (ts.isPropertyDeclaration(member) || ts.isParameter(member)) {
        collectExpressionDependencies(member.initializer, sourceFile, dependencies, ownName);
      }
    }
    if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        collectTypeDependencies(parameter.type, sourceFile, dependencies, ownName);
        collectExpressionDependencies(parameter.initializer, sourceFile, dependencies, ownName);
      }
      collectTypeDependencies(member.type, sourceFile, dependencies, ownName);
      collectExpressionDependencies(member.body, sourceFile, dependencies, ownName);
    }
    ts.forEachChild(member, visit);
  }
  for (const member of node.members) {
    visit(member);
  }
  return dependencies;
}

function collectModuleDependencies(sourceFile: ts.SourceFile): Set<string> {
  const dependencies = new Set<string>();
  addImportDependencies(sourceFile, dependencies);
  const localNames = new Set<string>();
  function collectLocalNames(node: ts.Node): void {
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name
    ) {
      localNames.add(node.name.text);
    }
    ts.forEachChild(node, collectLocalNames);
  }
  collectLocalNames(sourceFile);
  // messcript-disable-next-line CyclomaticComplexity
  function visit(node: ts.Node): void {
    if (ts.isTypeReferenceNode(node)) {
      const name = entityNameText(node.typeName, sourceFile);
      if (name && !localNames.has(name)) {
        addDependency(dependencies, name);
      }
    }
    if (ts.isNewExpression(node)) {
      const name = entityNameText(node.expression, sourceFile);
      if (name && !localNames.has(name)) {
        addDependency(dependencies, name);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        dependencies.add(`module:${argument.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return dependencies;
}

function moduleName(sourceFile: ts.SourceFile): string {
  const file = sourceFile.fileName.split(/[\\/]/).at(-1) ?? sourceFile.fileName;
  return file.replace(/\.d\.(?:m|c)?[jt]sx?$/i, "").replace(/\.(?:m|c)?[jt]sx?$/i, "");
}

export function findCouplingBetweenObjects(sourceFile: ts.SourceFile, maximum = properties.maximum): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const dependencies = collectClassDependencies(node, sourceFile);
    if (dependencies.size < maximum) {
      return;
    }
    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has a coupling between objects value of ${dependencies.size}. Consider to reduce the number of dependencies under ${maximum}.`,
      ),
    );
  });
  const moduleDependencies = collectModuleDependencies(sourceFile);
  if (moduleDependencies.size >= maximum) {
    const name = moduleName(sourceFile);
    findings.push(
      createDesignFinding(
        sourceFile,
        sourceFile,
        ruleName,
        priority,
        `module ${name}`,
        `The module ${name} has a coupling between objects value of ${moduleDependencies.size}. Consider to reduce the number of dependencies under ${maximum}.`,
      ),
    );
  }
  return findings;
}
