// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunctionLike, getFunctionContext } from "../ast/functions";
import { getFunctionBindingName } from "../ast/names";
import type { Finding } from "../finding";
import { createCamelCaseFinding } from "./camel-case-finding";
import { isCamelCaseName } from "./camel-case-utils";
import { isTestContextFileName } from "./test-context";

export const ruleName = "CamelCaseMethodName";
export const priority = 1;
export const properties = { "allow-underscore": false, "allow-underscore-test": false } as const;

export function findCamelCaseMethodName(sourceFile: ts.SourceFile): Finding[] {
  const allowUnderscore =
    properties["allow-underscore"] || (properties["allow-underscore-test"] && isTestContextFileName(sourceFile.fileName));
  const findings: Finding[] = [];
  forEachFunctionLike(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) {
      return;
    }
    const name = getFunctionBindingName(node, sourceFile);
    if (!name || isCamelCaseName(name, allowUnderscore)) {
      return;
    }
    findings.push(
      createCamelCaseFinding(node, sourceFile, ruleName, getFunctionContext(node, sourceFile), `The method ${name} is not named in camelCase.`),
    );
  });
  function visitSignature(node: ts.Node): void {
    if (ts.isMethodSignature(node) && node.name && !ts.isComputedPropertyName(node.name)) {
      const name =
        ts.isIdentifier(node.name) ||
        ts.isStringLiteral(node.name) ||
        ts.isNumericLiteral(node.name) ||
        ts.isNoSubstitutionTemplateLiteral(node.name)
          ? node.name.text
          : node.name.getText(sourceFile);
      if (!isCamelCaseName(name, allowUnderscore)) {
        findings.push(createCamelCaseFinding(node, sourceFile, ruleName, `method ${name}()`, `The method ${name} is not named in camelCase.`));
      }
    }
    ts.forEachChild(node, visitSignature);
  }
  visitSignature(sourceFile);
  return findings;
}
