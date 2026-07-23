// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachClass, getClassMethods, isIgnoredClassMethod, isPublicClassMember } from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";

export const ruleName = "TooManyPublicMethods";
export const priority = 3;
export const properties = { maxmethods: 10, ignorepattern: "(^(set|get|is|has|with))i" } as const;

export function findTooManyPublicMethods(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const methodCount = getClassMethods(node).filter(
      (method) => isPublicClassMember(method) && !isIgnoredClassMethod(method, sourceFile),
    ).length;
    if (methodCount <= properties.maxmethods) {
      return;
    }

    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${methodCount} public methods. Consider refactoring ${context.slice("class ".length)} to keep number of public methods under ${properties.maxmethods}.`,
      ),
    );
  });
  return findings;
}
