// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachClass, getClassFields, getClassMethods, isPublicClassMember } from "../ast/classes";
import type { Finding } from "../finding";
import { createClassFinding } from "./class-finding";

export const ruleName = "ExcessivePublicCount";
export const priority = 3;
export const properties = { minimum: 45 } as const;

export function findExcessivePublicCount(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachClass(sourceFile, (node) => {
    const publicCount = [
      ...getClassFields(node),
      ...getClassMethods(node),
    ].filter((member) => isPublicClassMember(member)).length;
    if (publicCount < properties.minimum) {
      return;
    }

    findings.push(
      createClassFinding(node, sourceFile, ruleName, priority, (context) =>
        `The ${context} has ${publicCount} public methods and attributes. Consider reducing the number of public items to less than ${properties.minimum}.`,
      ),
    );
  });
  return findings;
}
