import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { Finding } from "../finding";
import { createFunctionFinding } from "./function-finding";

export const ruleName = "ExcessiveParameterList";
export const priority = 3;
export const properties = { minimum: 10 } as const;

export function findExcessiveParameterList(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunction(sourceFile, (node) => {
    const parameterCount = node.parameters.filter((parameter) => {
      return !(ts.isIdentifier(parameter.name) && parameter.name.text === "this");
    }).length;
    if (parameterCount < properties.minimum) {
      return;
    }

    findings.push(
      createFunctionFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${parameterCount} parameters. Consider reducing the number of parameters to less than ${properties.minimum}.`,
      ),
    );
  });
  return findings;
}
