// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { calculateCyclomaticComplexity } from "../metrics/cyclomatic";
import { createFunctionFinding } from "./function-finding";

export const ruleName = "CyclomaticComplexity";
export const priority = 3;
export const properties = { reportLevel: 10 } as const;
export const reportLevel = 10;

function createCyclomaticComplexityFinding(
  node: FunctionLike,
  sourceFile: ts.SourceFile,
  complexity: number,
  threshold: number,
): Finding {
  return createFunctionFinding(node, sourceFile, ruleName, priority, (context) =>
    `The ${context} has a Cyclomatic Complexity of ${complexity}. The configured cyclomatic complexity threshold is ${threshold}.`,
  );
}

export function findCyclomaticComplexity(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const threshold = properties.reportLevel;

  forEachFunction(sourceFile, (node) => {
    const body = node.body;
    if (body) {
      const complexity = calculateCyclomaticComplexity(body);
      if (complexity > threshold) {
        findings.push(createCyclomaticComplexityFinding(node, sourceFile, complexity, threshold));
      }
    }
  });
  return findings;
}
