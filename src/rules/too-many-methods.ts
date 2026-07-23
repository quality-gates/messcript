// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachClass, getClassMethods, isIgnoredClassMethod } from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";

export const ruleName = "TooManyMethods";
export const priority = 3;
export const properties = { maxmethods: 25, ignorepattern: "(^(set|get|is|has|with))i" } as const;

export function findTooManyMethods(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const methodCount = getClassMethods(node).filter((method) => !isIgnoredClassMethod(method, sourceFile)).length;
    if (methodCount <= properties.maxmethods) {
      return;
    }

    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${methodCount} non-getter- and setter-methods. Consider refactoring ${context.slice("class ".length)} to keep number of methods under ${properties.maxmethods}.`,
      ),
    );
  });
  return findings;
}
