import ts from "typescript";
import type { ClassLike } from "../ast/classes";
import { getClassMethods } from "../ast/classes";
import { calculateCyclomaticComplexity } from "./cyclomatic";

export function calculateClassLineCount(
  node: ClassLike,
  sourceFile: ts.SourceFile,
  ignoreWhitespace: boolean,
): number {
  const start = node.getStart(sourceFile);
  const end = sourceFile.getLineAndCharacterOfPosition(Math.max(start, node.getEnd() - 1));
  if (!ignoreWhitespace) {
    return end.line - sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  }

  return sourceFile.text
    .slice(start, node.getEnd())
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

export function calculateClassComplexity(node: ClassLike): number {
  return getClassMethods(node).reduce(
    (complexity, method) => (method.body ? complexity + calculateCyclomaticComplexity(method.body) : complexity),
    0,
  );
}
