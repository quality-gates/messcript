// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { createDesignFinding, enclosingFunction, functionContextFor } from "./design-finding";

export const ruleName = "ExitExpression";
export const priority = 1;
export const properties = {} as const;

const exitTargets = new Set(["process.exit", "process.abort", "Deno.exit"]);

function propertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const argument = node.argumentExpression;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return undefined;
}

function isExitCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "exit";
  }
  if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) {
    return false;
  }
  if (!ts.isIdentifier(node.expression.expression)) {
    return false;
  }
  const property = propertyName(node.expression);
  return property !== undefined && exitTargets.has(`${node.expression.expression.text}.${property}`);
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
