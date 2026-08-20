// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachNamedType, getNamedTypeContext } from "../ast/names";
import type { Finding } from "../finding";
import { adjustedLength, parseCommaSeparatedNames } from "./naming-utils";
import { createNamingFinding } from "./naming-finding";

export const ruleName = "LongClassName";
export const priority = 3;
export const properties = { maximum: 40, "subtract-prefixes": "", "subtract-suffixes": "" } as const;

function adjustedClassNameLength(name: string): number {
  const prefixes = parseCommaSeparatedNames(properties["subtract-prefixes"]);
  const suffixes = parseCommaSeparatedNames(properties["subtract-suffixes"]);
  return adjustedLength(name, prefixes, suffixes);
}

export function findLongClassName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachNamedType(sourceFile, (node, name) => {
    if (adjustedClassNameLength(name) <= properties.maximum) {
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
