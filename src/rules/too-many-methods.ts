// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { defaultIgnoredMethodPattern, forEachClass, getClassMethods, isIgnoredClassMethod } from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";
import { compileIgnorePattern } from "./ignore-pattern";

export const ruleName = "TooManyMethods";
export const priority = 3;
export const properties = { maxmethods: 25, ignorepattern: defaultIgnoredMethodPattern } as const;

export function findTooManyMethods(sourceFile: ts.SourceFile): Finding[] {
  const ignoreRegex = compileIgnorePattern(properties.ignorepattern);
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const methodCount = getClassMethods(node).filter((method) => !isIgnoredClassMethod(method, sourceFile, ignoreRegex)).length;
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
