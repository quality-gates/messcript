import ts from "typescript";
import type { ClassLike } from "../ast/classes";
import { getClassMethods } from "../ast/classes";
import { calculateCyclomaticComplexity } from "./cyclomatic";
import { calculateNodeLineCount } from "./lines";

export function calculateClassLineCount(
  node: ClassLike,
  sourceFile: ts.SourceFile,
  ignoreWhitespace: boolean,
): number {
  return calculateNodeLineCount(node, sourceFile, ignoreWhitespace);
}

export function calculateClassComplexity(node: ClassLike): number {
  return getClassMethods(node).reduce(
    (complexity, method) => (method.body ? complexity + calculateCyclomaticComplexity(method.body) : complexity),
    0,
  );
}
