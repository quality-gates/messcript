import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { calculateNPathComplexity } from "../metrics/complexity";
import { createFunctionFinding } from "./function-finding";

export const ruleName = "NPathComplexity";
export const priority = 3;
export const properties = { minimum: 200 } as const;

function createFinding(node: FunctionLike, sourceFile: ts.SourceFile, complexity: number): Finding {
  return createFunctionFinding(node, sourceFile, ruleName, priority, (context) =>
    `The ${context} has an NPath complexity of ${complexity}. The configured NPath complexity threshold is ${properties.minimum}.`,
  );
}

export function findNPathComplexity(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunction(sourceFile, (node) => {
    if (!node.body) {
      return;
    }
    const complexity = calculateNPathComplexity(node.body);
    if (complexity >= properties.minimum) {
      findings.push(createFinding(node, sourceFile, complexity));
    }
  });
  return findings;
}
