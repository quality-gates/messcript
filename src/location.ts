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

// TypeScript's own scanner treats U+2028 (LINE SEPARATOR) and U+2029
// (PARAGRAPH SEPARATOR) as line terminators, per the ECMAScript spec.
// git, GitHub, GitLab, and virtually every editor do not: they only
// recognise \n and \r\n. Reporting positions straight from
// `sourceFile.getLineAndCharacterOfPosition` therefore drifts away from
// the line numbers every other tool agrees on whenever source contains
// one of those (legal, near-invisible) characters. `locate` recomputes
// line/column using a \n-and-\r\n-only line map instead, so findings
// stay aligned with what a diff, an editor, or a CI annotation shows.
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

export function locate(sourceFile: ts.SourceFile, position: number): { line: number; character: number } {
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

