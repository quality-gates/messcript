// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { collectParameters } from "../ast/names";
import type { Finding } from "../finding";
import { createCamelCaseFinding } from "./camel-case-finding";
import { isCamelCaseName } from "./camel-case-utils";

export const ruleName = "CamelCaseParameterName";
export const priority = 1;
export const properties = { "allow-underscore": false } as const;

export function findCamelCaseParameterName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const parameter of collectParameters(sourceFile)) {
    if (isCamelCaseName(parameter.name)) {
      continue;
    }
    findings.push(
      createCamelCaseFinding(parameter.node, sourceFile, ruleName, parameter.context, `The parameter ${parameter.name} is not named in camelCase.`),
    );
  }
  return findings;
}
