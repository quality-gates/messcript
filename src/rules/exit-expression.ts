// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { globalReference } from "../ast/global-reference";
import { createDesignFinding, enclosingFunction, functionContextFor } from "./design-finding";

export const ruleName = "ExitExpression";
export const priority = 1;
export const properties = {} as const;

const exitTargets = new Set(["exit", "process.exit", "process.abort", "Deno.exit"]);

function isExitCall(node: ts.CallExpression): boolean {
  const reference = globalReference(node.expression);
  return reference !== undefined && exitTargets.has(reference);
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
