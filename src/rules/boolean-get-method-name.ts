// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { getFunctionContext } from "../ast/functions";
import { forEachCallableDeclaration } from "../ast/overloads";
import { collectBooleanReturns, getFunctionBindingName, getNameWithoutSigil } from "../ast/names";
import type { Finding } from "../finding";
import { isBooleanExpression, isBooleanType } from "../metrics/boolean";
import { createNamingFinding } from "./naming-finding";
import { isBooleanFunction } from "./naming-utils";

export const ruleName = "BooleanGetMethodName";
export const priority = 4;
export const properties = { checkParameterizedMethods: false } as const;

export function findBooleanGetMethodName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachCallableDeclaration(sourceFile, (node, declarationLines, implementation) => {
    const effective = implementation ?? node;
    const name = getFunctionBindingName(node, sourceFile);
    if (!name || !/^get/i.test(getNameWithoutSigil(name)) || effective.body === undefined) {
      return;
    }
    if (!properties.checkParameterizedMethods && effective.parameters.length > 0) {
      return;
    }
    if (!isBooleanFunction(effective, collectBooleanReturns(effective.body), isBooleanExpression, isBooleanType)) {
      return;
    }
    findings.push(
      createNamingFinding(
        node,
        sourceFile,
        ruleName,
        priority,
        getFunctionContext(node, sourceFile),
        `The '${getNameWithoutSigil(name)}()' method which returns a boolean should be named 'is...()' or 'has...()'`,
        declarationLines,
      ),
    );
  });
  return findings;
}
