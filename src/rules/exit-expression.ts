// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { createDesignFinding, enclosingFunction, functionContextFor } from "./design-finding";

export const ruleName = "ExitExpression";
export const priority = 1;
export const properties = {} as const;

function isExitCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "exit";
  }
  if (!ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) {
    return false;
  }
  const target = `${node.expression.expression.text}.${node.expression.name.text}`;
  return target === "process.exit" || target === "process.abort" || target === "Deno.exit";
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
