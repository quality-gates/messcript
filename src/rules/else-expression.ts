// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunction, isFunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { createCleanCodeFinding, functionContext, functionName } from "./clean-code-finding";

export const ruleName = "ElseExpression";
export const priority = 1;
export const properties = {} as const;

function visitExecutableStatements(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  context: string,
  methodName: string,
  findings: Finding[],
): void {
  if (isFunctionLike(node)) {
    return;
  }
  if (ts.isIfStatement(node) && node.elseStatement && !ts.isIfStatement(node.elseStatement)) {
    findings.push(
      createCleanCodeFinding(
        node.elseStatement,
        sourceFile,
        ruleName,
        priority,
        context,
        `The method ${methodName} uses an else expression. Else clauses are basically not necessary and you can simplify the code by not using them.`,
      ),
    );
  }
  ts.forEachChild(node, (child) => visitExecutableStatements(child, sourceFile, context, methodName, findings));
}

export function findElseExpression(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunction(sourceFile, (node) => {
    if (node.body) {
      const context = functionContext(node, sourceFile);
      const name = functionName(node, sourceFile);
      visitExecutableStatements(node.body, sourceFile, context, name, findings);
    }
  });
  return findings;
}
