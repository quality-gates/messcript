// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { getFunctionContext } from "../ast/functions";
import { forEachCallableDeclaration } from "../ast/overloads";
import { classifyName, getFunctionBindingName, getNameWithoutSigil } from "../ast/names";
import type { Finding } from "../finding";
import { createNamingFinding } from "./naming-finding";
import { isIdiomaticShortName, parseCommaSeparatedNames } from "./naming-utils";
import type { RuleDefinition } from "./catalog";

export const ruleName = "ShortMethodName";
export const priority = 3;
export const properties = { minimum: 3, exceptions: "" } as const;

export function findShortMethodName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const exceptions = parseCommaSeparatedNames(properties.exceptions);
  forEachCallableDeclaration(sourceFile, (node, declarationLines) => {
    const name = getFunctionBindingName(node, sourceFile);
    if (
      !name ||
      exceptions.includes(name) ||
      getNameWithoutSigil(name).length >= properties.minimum ||
      isIdiomaticShortName(name) ||
      classifyName(name, node) !== "ordinary"
    ) {
      return;
    }
    findings.push(
      createNamingFinding(
        node,
        sourceFile,
        ruleName,
        priority,
        getFunctionContext(node, sourceFile),
        `Avoid using short method names like ${name}(). The configured minimum method name length is ${properties.minimum}.`,
        declarationLines,
      ),
    );
  });
  return findings;
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findShortMethodName(sourceFile),
};
