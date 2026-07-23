// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { collectSemanticConstants, collectVariables } from "../ast/names";
import type { Finding } from "../finding";
import { createCamelCaseFinding } from "./camel-case-finding";
import { isCamelCaseName } from "./camel-case-utils";

export const ruleName = "CamelCaseVariableName";
export const priority = 1;
export const properties = { "allow-underscore": false } as const;

export function findCamelCaseVariableName(sourceFile: ts.SourceFile): Finding[] {
  const constantStarts = new Set(collectSemanticConstants(sourceFile).map((constant) => constant.node.getStart(sourceFile)));
  const findings: Finding[] = [];
  for (const variable of collectVariables(sourceFile)) {
    if (constantStarts.has(variable.node.getStart(sourceFile)) || isCamelCaseName(variable.name)) {
      continue;
    }
    findings.push(
      createCamelCaseFinding(variable.node, sourceFile, ruleName, variable.context, `The variable ${variable.name} is not named in camelCase.`),
    );
  }
  return findings;
}
