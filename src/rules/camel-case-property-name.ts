// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { collectProperties } from "../ast/names";
import type { Finding } from "../finding";
import { createCamelCaseFinding } from "./camel-case-finding";
import { isCamelCaseName } from "./camel-case-utils";

export const ruleName = "CamelCasePropertyName";
export const priority = 1;
export const properties = { "allow-underscore": false, "allow-underscore-test": false } as const;

export function findCamelCasePropertyName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const property of collectProperties(sourceFile)) {
    if (isCamelCaseName(property.name)) {
      continue;
    }
    findings.push(
      createCamelCaseFinding(property.node, sourceFile, ruleName, property.context, `The property ${property.name} is not named in camelCase.`),
    );
  }
  return findings;
}
