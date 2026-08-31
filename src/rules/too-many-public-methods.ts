// messcript-disable ConstantNamingConventions
import ts from "typescript";
import {
  defaultIgnoredMethodPattern,
  forEachClass,
  getClassMethods,
  isIgnoredClassMethod,
  isPublicClassMember,
} from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";
import { compileIgnorePattern } from "./ignore-pattern";

export const ruleName = "TooManyPublicMethods";
export const priority = 3;
export const properties = { maxmethods: 10, ignorepattern: defaultIgnoredMethodPattern } as const;

export function findTooManyPublicMethods(sourceFile: ts.SourceFile): Finding[] {
  const ignoreRegex = compileIgnorePattern(properties.ignorepattern);
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const methodCount = getClassMethods(node).filter(
      (method) => isPublicClassMember(method) && !isIgnoredClassMethod(method, sourceFile, ignoreRegex),
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
