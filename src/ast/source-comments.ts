// messcript-disable ConstantNamingConventions
import ts from "typescript";

export type SourceComment = {
  readonly pos: number;
  readonly text: string;
  readonly kind: ts.CommentKind;
};

type TextSpan = {
  pos: number;
  end: number;
};

// messcript-disable-next-line GlobalVariable
const sourceCommentCache = new WeakMap<ts.SourceFile, readonly SourceComment[]>();

function addCommentRanges(
  sourceFile: ts.SourceFile,
  ranges: readonly ts.CommentRange[] | undefined,
  commentsByPosition: Map<number, SourceComment>,
): void {
  for (const range of ranges ?? []) {
    commentsByPosition.set(range.pos, {
      pos: range.pos,
      text: sourceFile.text.slice(range.pos, range.end),
      kind: range.kind,
    });
  }
}

export function sourceComments(sourceFile: ts.SourceFile): readonly SourceComment[] {
  const cached = sourceCommentCache.get(sourceFile);
  if (cached) {
    return cached;
  }

  const commentsByPosition = new Map<number, SourceComment>();
  const jsxTextSpans: TextSpan[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      jsxTextSpans.push({ pos: node.pos, end: node.end });
    }

    for (const child of node.getChildren(sourceFile)) {
      addCommentRanges(sourceFile, ts.getLeadingCommentRanges(sourceFile.text, child.pos), commentsByPosition);
      addCommentRanges(sourceFile, ts.getTrailingCommentRanges(sourceFile.text, child.end), commentsByPosition);
      visit(child);
    }
  }
  visit(sourceFile);

  const comments = [...commentsByPosition.values()].sort((left, right) => left.pos - right.pos);
  const result: SourceComment[] = [];
  let jsxTextIndex = 0;
  for (const comment of comments) {
    while (jsxTextIndex < jsxTextSpans.length && jsxTextSpans[jsxTextIndex].end <= comment.pos) {
      jsxTextIndex += 1;
    }
    const jsxText = jsxTextSpans[jsxTextIndex];
    if (!jsxText || comment.pos < jsxText.pos) {
      result.push(comment);
    }
  }

  const cachedComments = Object.freeze(result.map((comment) => Object.freeze(comment)));
  sourceCommentCache.set(sourceFile, cachedComments);
  return cachedComments;
}
