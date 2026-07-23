import ts from "typescript";
import { forEachClass } from "../ast/classes";
import type { Finding } from "../finding";
import { calculateLcom4 } from "../metrics/cohesion";
import { createClassFinding } from "./class-finding";

export const ruleName = "LackOfCohesionOfMethods";
export const priority = 3;
export const properties = { maximum: 1 } as const;

export function findLackOfCohesionOfMethods(sourceFile: ts.SourceFile, maximum = properties.maximum): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const lcom = calculateLcom4(node);
    if (lcom <= maximum) {
      return;
    }
    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has a Lack of Cohesion Of Methods (LCOM4) value of ${lcom}. Consider to split this class into ${lcom} smaller classes.`,
      ),
    );
  });
  return findings;
}
