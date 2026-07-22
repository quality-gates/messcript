import ts from "typescript";
import { getClassMethodName, getClassMethods } from "../ast/classes";
import { forEachNamedType } from "../ast/names";
import type { Finding } from "../finding";
import { createNamingFinding } from "./naming-finding";

export const ruleName = "ConstructorWithNameAsEnclosingClass";
export const priority = 3;
export const properties = {} as const;

export function findConstructorWithNameAsEnclosingClass(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachNamedType(sourceFile, (node, className) => {
    if (ts.isInterfaceDeclaration(node)) {
      return;
    }
    for (const method of getClassMethods(node)) {
      if (getClassMethodName(method, sourceFile) !== className || ts.isConstructorDeclaration(method)) {
        continue;
      }
      findings.push(
        createNamingFinding(
          method,
          sourceFile,
          ruleName,
          priority,
          `method ${className}()`,
          "Classes should not have a constructor method with the same name as the class",
        ),
      );
    }
  });
  return findings;
}
