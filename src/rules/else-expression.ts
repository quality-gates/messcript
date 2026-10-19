// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { visitExecutableRegions } from "../ast/executable-regions";
import type { Finding } from "../finding";
import { createCleanCodeFinding, functionContext, functionName } from "./clean-code-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "ElseExpression";
export const priority = 1;
export const properties = {} as const;

export function findElseExpression(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  visitExecutableRegions(sourceFile, (node, owner) => {
    if (!ts.isIfStatement(node) || !node.elseStatement || ts.isIfStatement(node.elseStatement)) {
      return;
    }
    const context = ts.isSourceFile(owner) ? "module" : functionContext(owner, sourceFile);
    const methodName = ts.isSourceFile(owner) ? "module" : functionName(owner, sourceFile);
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
  });
  return findings;
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findElseExpression(sourceFile),
};
