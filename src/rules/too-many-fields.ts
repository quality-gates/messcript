import ts from "typescript";
import { forEachClass, getClassFields } from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";

export const ruleName = "TooManyFields";
export const priority = 3;
export const properties = { maxfields: 15 } as const;

export function findTooManyFields(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const fieldCount = getClassFields(node).length;
    if (fieldCount <= properties.maxfields) {
      return;
    }

    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${fieldCount} fields. Consider redesigning ${context.slice("class ".length)} to keep the number of fields under ${properties.maxfields}.`,
      ),
    );
  });
  return findings;
}
