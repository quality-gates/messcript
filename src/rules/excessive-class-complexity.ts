// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachClass } from "../ast/classes";
import type { Finding } from "../finding";
import { calculateClassComplexity } from "../metrics/classes";
import { createClassFinding } from "./class-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "ExcessiveClassComplexity";
export const priority = 3;
export const properties = { maximum: 50 } as const;

export function findExcessiveClassComplexity(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const complexity = calculateClassComplexity(node);
    if (complexity < properties.maximum) {
      return;
    }

    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has an overall complexity of ${complexity} which is very high. The configured complexity threshold is ${properties.maximum}.`,
      ),
    );
  });
  return findings;
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findExcessiveClassComplexity(sourceFile),
};
