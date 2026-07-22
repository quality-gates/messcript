import ts from "typescript";
import { forEachNamedType, getNamedTypeContext } from "../ast/names";
import type { Finding } from "../finding";
import { adjustedLength } from "./naming-utils";
import { createNamingFinding } from "./naming-finding";

export const ruleName = "LongClassName";
export const priority = 3;
export const properties = { maximum: 40, "subtract-prefixes": "", "subtract-suffixes": "" } as const;

export function findLongClassName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachNamedType(sourceFile, (node, name) => {
    if (adjustedLength(name) <= properties.maximum) {
      return;
    }
    findings.push(
      createNamingFinding(
        node,
        sourceFile,
        ruleName,
        priority,
        getNamedTypeContext(node, sourceFile),
        `Avoid excessively long class names like ${name}. Keep class name length under ${properties.maximum}.`,
      ),
    );
  });
  return findings;
}
