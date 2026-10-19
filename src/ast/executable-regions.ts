import ts from "typescript";
import { forEachFunction, isFunctionLike } from "./functions";
import type { FunctionLike } from "./functions";
import { walkAst } from "./walk";

/** Visit the root and its descendants in preorder. Exclude function-like nodes and their children. */
export function walkExecutableRegion(root: ts.Node, callback: (node: ts.Node) => void): void {
  walkAst(root, (node) => {
    if (isFunctionLike(node)) {
      return false;
    }
    callback(node);
  });
}

/**
 * Visit the module first, then each function body in function source preorder.
 * Each pass includes its root and excludes nested function-like nodes.
 * Class static blocks keep the owner of the enclosing region.
 * Exclude function parameters, but visit bodies of functions declared in parameters.
 */
export function visitExecutableRegions(
  sourceFile: ts.SourceFile,
  callback: (node: ts.Node, owner: ts.SourceFile | FunctionLike) => void,
): void {
  walkExecutableRegion(sourceFile, (node) => callback(node, sourceFile));
  forEachFunction(sourceFile, (owner) => {
    if (owner.body) {
      walkExecutableRegion(owner.body, (node) => callback(node, owner));
    }
  });
}
