// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { createCleanCodeFinding } from "./clean-code-finding";

export const ruleName = "DuplicatedArrayKey";
export const priority = 2;
export const properties = {} as const;

type StaticKey = { key: string; display: string; node: ts.Node };

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

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function propertyName(property: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile): StaticKey | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return { key: property.name.text, display: property.name.text, node: property.name };
  }
  if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property) && !ts.isGetAccessorDeclaration(property) && !ts.isSetAccessorDeclaration(property)) {
    return undefined;
  }
  const name = property.name;
  if (ts.isIdentifier(name)) {
    return { key: name.text, display: name.text, node: name };
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    const key = staticExpressionKey(name);
    return key === undefined ? undefined : { key, display: name.getText(sourceFile), node: name };
  }
  if (ts.isComputedPropertyName(name)) {
    const key = staticExpressionKey(name.expression);
    return key === undefined ? undefined : { key, display: name.getText(sourceFile), node: name };
  }
  return undefined;
}

function checkObjectLiteral(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile, findings: Finding[]): void {
  const seen = new Map<string, { line: number }>();
  for (const property of node.properties) {
    const key = propertyName(property, sourceFile);
    if (!key) {
      continue;
    }
    const line = sourceFile.getLineAndCharacterOfPosition(key.node.getStart(sourceFile)).line + 1;
    const first = seen.get(key.key);
    if (first) {
      findings.push(
        createCleanCodeFinding(
          key.node,
          sourceFile,
          ruleName,
          priority,
          "object literal",
          `Duplicated array key ${key.display}, first declared at line ${first.line}.`,
        ),
      );
    } else {
      seen.set(key.key, { line });
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
