// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachNamedType, getNamedTypeContext } from "../ast/names";
import type { Finding } from "../finding";
import { createCamelCaseFinding } from "./camel-case-finding";
import { isPascalCaseName } from "./camel-case-utils";

export const ruleName = "CamelCaseClassName";
export const priority = 1;
export const properties = {} as const;

export function findCamelCaseClassName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachNamedType(sourceFile, (node, name) => {
    if (isPascalCaseName(name)) {
      return;
    }
    findings.push(
      createCamelCaseFinding(node, sourceFile, ruleName, getNamedTypeContext(node, sourceFile), `The class ${name} is not named in CamelCase.`),
    );
  });
  return findings;
}
