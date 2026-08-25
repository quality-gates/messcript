// messcript-disable ConstantNamingConventions
import type ts from "typescript";

export type Located = {
  path: string;
  line: number;
  column: number;
};

export function compareLocations(left: Located, right: Located): number {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

// TypeScript treats U+2028 and U+2029 as line terminators. Git, GitHub,
// GitLab, and most editors do not: they use only \n and \r\n. This
// makes `sourceFile.getLineAndCharacterOfPosition` report the wrong
// line for source that contains U+2028 or U+2029. `locate` computes
// the line and column from a \n-and-\r\n-only map instead, so findings
// match the line numbers a diff, an editor, or a CI annotation shows.
const lineStartsByFile = new WeakMap<ts.SourceFile, readonly number[]>();

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13 /* \r */) {
      if (text.charCodeAt(index + 1) === 10 /* \n */) {
        index += 1;
      }
      starts.push(index + 1);
    } else if (code === 10 /* \n */) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineStartsFor(sourceFile: ts.SourceFile): readonly number[] {
  let starts = lineStartsByFile.get(sourceFile);
  if (!starts) {
    starts = computeLineStarts(sourceFile.text);
    lineStartsByFile.set(sourceFile, starts);
  }
  return starts;
}

export function locate(sourceFile: ts.SourceFile, position: number): ts.LineAndCharacter {
  const starts = lineStartsFor(sourceFile);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= position) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low, character: position - starts[low] };
}

