// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachNamedType, getNamedTypeContext } from "../ast/names";
import type { Finding } from "../finding";
import { createNamingFinding } from "./naming-finding";
import { parseCommaSeparatedNames } from "./naming-utils";

export const ruleName = "ShortClassName";
export const priority = 3;
export const properties = { minimum: 3, exceptions: "" } as const;

export function findShortClassName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachNamedType(sourceFile, (node, name) => {
    if (name.length >= properties.minimum || parseCommaSeparatedNames(properties.exceptions).includes(name)) {
      return;
    }
    findings.push(
      createNamingFinding(
        node,
        sourceFile,
        ruleName,
        priority,
        getNamedTypeContext(node, sourceFile),
        `Avoid classes with short names like ${name}. Configured minimum length is ${properties.minimum}.`,
      ),
    );
  });
  return findings;
}
