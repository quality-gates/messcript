// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { Finding } from "../finding";
import { calculateNodeLineCount } from "../metrics/lines";
import { createFunctionFinding } from "./function-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "ExcessiveMethodLength";
export const priority = 3;
export const properties = { minimum: 100, "ignore-whitespace": false } as const;

export function findExcessiveMethodLength(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunction(sourceFile, (node) => {
    const lineCount = calculateNodeLineCount(node, sourceFile, properties["ignore-whitespace"]);
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

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  aliases: { maximum: "minimum" },
  run: (sourceFile) => findExcessiveMethodLength(sourceFile),
};
