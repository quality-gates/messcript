// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { isGlobalObject } from "../ast/global-object";
import { isLocallyBound } from "../ast/local-bindings";
import { createDesignFinding, enclosingFunction, functionContextFor } from "./design-finding";

export const ruleName = "ExitExpression";
export const priority = 1;
export const properties = {} as const;

const exitTargets = new Set(["process.exit", "process.abort", "Deno.exit"]);

function unwrapParenthesized(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (!ts.isElementAccessExpression(node)) {
    return undefined;
  }
  const argument = unwrapParenthesized(node.argumentExpression);
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return undefined;
}

function receiverName(node: ts.Expression): string | undefined {
  const receiver = unwrapParenthesized(node);
  if (ts.isIdentifier(receiver)) {
    return receiver.text;
  }
  if ((ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) && isGlobalObject(unwrapParenthesized(receiver.expression))) {
    return propertyName(receiver);
  }
  return undefined;
}

function isExitCall(node: ts.CallExpression): boolean {
  const callee = unwrapParenthesized(node.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === "exit" && !isLocallyBound(callee);
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }
  // A missing receiver or property renders as "undefined", which no exit target contains.
  return exitTargets.has(`${receiverName(callee.expression)}.${propertyName(callee)}`);
}

export function findExitExpression(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const reportedScopes = new Set<ts.Node>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isExitCall(node)) {
      const scope = enclosingFunction(node) ?? sourceFile;
      if (!reportedScopes.has(scope)) {
        const context = functionContextFor(node, sourceFile);
        findings.push(
          createDesignFinding(
            node,
            sourceFile,
            ruleName,
            priority,
            context,
            `The ${context} contains an exit expression.`,
          ),
        );
        reportedScopes.add(scope);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}
