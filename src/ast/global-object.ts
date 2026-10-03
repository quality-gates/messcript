// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { isLocallyBound } from "./local-bindings";

// Names of the global object. A global is also reached through them, as in globalThis.process.
const globalObjects = new Set(["globalThis", "self", "window"]);

/**
 * Reports whether the expression names the global object and is not shadowed by a local declaration.
 */
export function isGlobalObject(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && globalObjects.has(node.text) && !isLocallyBound(node);
}
