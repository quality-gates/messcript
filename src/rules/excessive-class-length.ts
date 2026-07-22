import ts from "typescript";
import { forEachClass } from "../ast/classes";
import type { Finding } from "../finding";
import { calculateClassLineCount } from "../metrics/classes";
import { createClassFinding } from "./class-finding";

export const ruleName = "ExcessiveClassLength";
export const priority = 3;
export const properties = { minimum: 1000, "ignore-whitespace": false } as const;

export function findExcessiveClassLength(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const lineCount = calculateClassLineCount(node, sourceFile, properties["ignore-whitespace"]);
    if (lineCount < properties.minimum) {
      return;
    }

    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${lineCount} lines of code. Current threshold is set to ${properties.minimum}. Avoid really long classes.`,
      ),
    );
  });
  return findings;
}
