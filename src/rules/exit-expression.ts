// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { createDesignFinding, enclosingFunction, functionContextFor } from "./design-finding";

export const ruleName = "ExitExpression";
export const priority = 1;
export const properties = {} as const;

const exitTargets = new Set(["process.exit", "process.abort", "Deno.exit"]);

function unwrapParenthesized(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const argument = unwrapParenthesized(node.argumentExpression);
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return undefined;
}

function isExitCall(node: ts.CallExpression): boolean {
  const callee = unwrapParenthesized(node.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === "exit";
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }
  const receiver = unwrapParenthesized(callee.expression);
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  const property = propertyName(callee);
  return property !== undefined && exitTargets.has(`${receiver.text}.${property}`);
}

export function findExitExpression(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const reportedScopes = new Set<ts.Node>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isExitCall(node)) {
      const scope = enclosingFunction(node) ?? sourceFile;
      if (!reportedScopes.has(scope)) {
        const context = functionContextFor(node, sourceFile);
        findings.push(
          createDesignFinding(
            node,
            sourceFile,
            ruleName,
            priority,
            context,
            `The ${context} contains an exit expression.`,
          ),
        );
        reportedScopes.add(scope);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}
