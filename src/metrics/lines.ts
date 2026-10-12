import type ts from "typescript";
import { locate } from "../location";

export function calculateNodeLineCount(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  ignoreWhitespace: boolean,
): number {
  const start = node.getStart(sourceFile);
  const end = locate(sourceFile, Math.max(start, node.getEnd() - 1));
  if (!ignoreWhitespace) {
    return end.line - locate(sourceFile, start).line + 1;
  }

  return sourceFile.text
    .slice(start, node.getEnd())
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}
