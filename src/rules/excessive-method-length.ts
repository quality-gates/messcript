import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { Finding } from "../finding";
import { createFunctionFinding } from "./function-finding";

export const ruleName = "ExcessiveMethodLength";
export const priority = 3;
export const properties = { minimum: 100, "ignore-whitespace": false } as const;

export function findExcessiveMethodLength(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunction(sourceFile, (node) => {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(Math.max(node.getStart(sourceFile), node.getEnd() - 1));
    const lineCount = properties["ignore-whitespace"]
      ? sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()).split(/\r?\n/).filter((line) => line.trim().length > 0).length
      : end.line - start.line + 1;
    if (lineCount < properties.minimum) {
      return;
    }

    findings.push(
      createFunctionFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${lineCount} lines of code. Current threshold is set to ${properties.minimum}. Avoid really long methods.`,
      ),
    );
  });
  return findings;
}
