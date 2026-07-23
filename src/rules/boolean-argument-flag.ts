// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { Finding } from "../finding";
import {
  createCleanCodeFinding,
  enclosingClass,
  functionContext,
  functionImage,
  isPublicFunction,
} from "./clean-code-finding";

export const ruleName = "BooleanArgumentFlag";
export const priority = 1;
export const properties = { exceptions: "", ignorepattern: "" } as const;

function unwrapType(type: ts.TypeNode): ts.TypeNode {
  if (ts.isParenthesizedTypeNode(type)) {
    return unwrapType(type.type);
  }
  return type;
}

function isBooleanType(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  const unwrapped = unwrapType(type);
  if (unwrapped.kind === ts.SyntaxKind.BooleanKeyword) {
    return true;
  }
  if (ts.isTypeReferenceNode(unwrapped) && ts.isIdentifier(unwrapped.typeName)) {
    return unwrapped.typeName.text === "Boolean";
  }
  if (ts.isUnionTypeNode(unwrapped)) {
    return unwrapped.types.some((part) => isBooleanType(part));
  }
  return false;
}

function isBooleanInitializer(node: ts.Expression | undefined): boolean {
  if (!node) {
    return false;
  }
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
  );
}

function booleanBindingIdentifiers(name: ts.BindingName, initializer: ts.Expression | undefined): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return isBooleanInitializer(initializer) ? [name] : [];
  }

  const identifiers: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }
    if (ts.isIdentifier(element.name) && isBooleanInitializer(element.initializer)) {
      identifiers.push(element.name);
    } else if (!ts.isIdentifier(element.name)) {
      identifiers.push(...booleanBindingIdentifiers(element.name, element.initializer));
    }
  }
  return identifiers;
}

function isIgnored(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const owner = enclosingClass(node);
  if (owner && properties.exceptions.split(",").map((value) => value.trim()).includes(owner.name?.text ?? "")) {
    return true;
  }
  const methodName = ts.isFunctionLike(node) && node.name && !ts.isComputedPropertyName(node.name)
    ? node.name.getText(sourceFile)
    : "";
  return properties.ignorepattern.length > 0 && new RegExp(properties.ignorepattern).test(methodName);
}

export function findBooleanArgumentFlag(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunction(sourceFile, (node) => {
    if (!isPublicFunction(node, sourceFile) || isIgnored(node, sourceFile)) {
      return;
    }
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === "this") {
        continue;
      }
      const identifiers = isBooleanType(parameter.type)
        ? ts.isIdentifier(parameter.name) ? [parameter.name] : []
        : booleanBindingIdentifiers(parameter.name, parameter.initializer);
      for (const identifier of identifiers) {
        findings.push(
          createCleanCodeFinding(
            identifier,
            sourceFile,
            ruleName,
            priority,
            functionContext(node, sourceFile),
            `The method ${functionImage(node, sourceFile)} has a boolean flag argument ${identifier.text}, which is a certain sign of a Single Responsibility Principle violation.`,
          ),
        );
      }
    }
  });
  return findings;
}
