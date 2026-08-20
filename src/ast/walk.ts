import ts from "typescript";

export function walkAst(root: ts.Node, callback: (node: ts.Node) => boolean | void): void {
  const pending: ts.Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || callback(node) === false) {
      continue;
    }
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
}
