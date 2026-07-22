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

