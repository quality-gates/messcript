// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { locate } from "../location";
import { createCleanCodeFinding } from "./clean-code-finding";

export const ruleName = "DuplicatedArrayKey";
export const priority = 2;
export const properties = {} as const;

type KeyKind = "get" | "set" | "value";
type StaticKey = { key: string; display: string; node: ts.Node; kind: KeyKind };

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function staticExpressionKey(node: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(node)) {
    return staticExpressionKey(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isNaN(value) ? undefined : String(value);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return "true";
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return "false";
  }
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken)) {
    const value = staticExpressionKey(node.operand);
    if (value === undefined || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
      return undefined;
    }
    return String(node.operator === ts.SyntaxKind.MinusToken ? -Number(value) : Number(value));
  }
  return undefined;
}

function propertyKind(property: ts.ObjectLiteralElementLike): KeyKind {
  if (ts.isGetAccessorDeclaration(property)) {
    return "get";
  }
  if (ts.isSetAccessorDeclaration(property)) {
    return "set";
  }
  return "value";
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function propertyName(property: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile): StaticKey | undefined {
  const kind = propertyKind(property);
  if (ts.isShorthandPropertyAssignment(property)) {
    return { key: property.name.text, display: property.name.text, node: property.name, kind };
  }
  if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property) && !ts.isGetAccessorDeclaration(property) && !ts.isSetAccessorDeclaration(property)) {
    return undefined;
  }
  const name = property.name;
  if (ts.isIdentifier(name)) {
    return { key: name.text, display: name.text, node: name, kind };
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    const key = staticExpressionKey(name);
    return key === undefined ? undefined : { key, display: name.getText(sourceFile), node: name, kind };
  }
  if (ts.isComputedPropertyName(name)) {
    const key = staticExpressionKey(name.expression);
    return key === undefined ? undefined : { key, display: name.getText(sourceFile), node: name, kind };
  }
  return undefined;
}

type KeyRecord = { get?: { line: number }; set?: { line: number }; value?: { line: number } };

function checkObjectLiteral(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile, findings: Finding[]): void {
  const seen = new Map<string, KeyRecord>();
  for (const property of node.properties) {
    const key = propertyName(property, sourceFile);
    if (!key) {
      continue;
    }
    const line = locate(sourceFile, key.node.getStart(sourceFile)).line + 1;
    const record = seen.get(key.key) ?? {};
    let conflictLine: number | undefined;

    if (key.kind === "get") {
      conflictLine = record.get?.line ?? record.value?.line;
      record.get = { line };
    } else if (key.kind === "set") {
      conflictLine = record.set?.line ?? record.value?.line;
      record.set = { line };
    } else {
      conflictLine = record.value?.line ?? record.get?.line ?? record.set?.line;
      record.value = { line };
    }

    if (conflictLine !== undefined) {
      findings.push(
        createCleanCodeFinding(
          key.node,
          sourceFile,
          ruleName,
          priority,
          "object literal",
          `Duplicated array key ${key.display}, first declared at line ${conflictLine}.`,
        ),
      );
    } else {
      seen.set(key.key, record);
    }
  }
}

export function findDuplicatedArrayKey(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      checkObjectLiteral(node, sourceFile, findings);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}
