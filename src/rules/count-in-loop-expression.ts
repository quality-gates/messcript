// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { isFunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { createDesignFinding, functionContextFor } from "./design-finding";

export const ruleName = "CountInLoopExpression";
export const priority = 2;
export const properties = {} as const;

const countNames = new Set(["length", "size", "count"]);

function accessedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (!ts.isElementAccessExpression(node)) {
    return undefined;
  }
  const argument = node.argumentExpression;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return undefined;
}

function countName(node: ts.Node): string | undefined {
  const accessed = accessedName(node);
  if (accessed && countNames.has(accessed)) {
    return accessed;
  }
  if (ts.isCallExpression(node) && accessedName(node.expression) === "count") {
    return "count";
  }
  return undefined;
}

function findCount(node: ts.Node): string | undefined {
  if (isFunctionLike(node)) {
    return undefined;
  }
  const direct = countName(node);
  if (direct) {
    return direct;
  }
  let result: string | undefined;
  ts.forEachChild(node, (child) => {
    result ??= findCount(child);
  });
  return result;
}

export function findCountInLoopExpression(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  function visit(node: ts.Node): void {
    let loopKind: string | undefined;
    let condition: ts.Expression | undefined;
    if (ts.isForStatement(node)) {
      loopKind = "for";
      condition = node.condition ?? undefined;
    } else if (ts.isWhileStatement(node)) {
      loopKind = "while";
      condition = node.expression;
    } else if (ts.isDoStatement(node)) {
      loopKind = "do";
      condition = node.expression;
    }
    if (loopKind && condition) {
      const name = findCount(condition);
      if (name) {
        const context = functionContextFor(node, sourceFile);
        findings.push(
          createDesignFinding(
            condition,
            sourceFile,
            ruleName,
            priority,
            context,
            `Avoid using ${name} in ${loopKind} loops.`,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}
