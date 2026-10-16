import ts from "typescript";
import { getFunctionContext, isFunctionLike, isFunctionLikeWithBody, type FunctionLike } from "../ast/functions";

/**
 * Code that owns the effects in its body.
 * A source file owns the code that runs when the module loads. A class without an explicit constructor owns
 * its implicit constructor, which runs the instance field initializers. An explicit constructor owns them instead.
 */
export type EffectOwner = FunctionLike | ts.SourceFile | ts.ClassLikeDeclaration;

const MODULE_CONTEXT = "<module>";

/** Gives the parameters of the owner. A module and a class field initializer take none. */
export function ownerParameters(owner: EffectOwner): readonly ts.ParameterDeclaration[] {
  return isFunctionLike(owner) ? owner.parameters : [];
}

/** Gives the finding context of the owner. */
export function ownerContext(owner: EffectOwner, sourceFile: ts.SourceFile): string {
  if (ts.isSourceFile(owner)) {
    return MODULE_CONTEXT;
  }
  const context = isFunctionLike(owner) ? getFunctionContext(owner, sourceFile) : "constructor";
  const member = ts.isMethodDeclaration(owner) || ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner);
  return member && ts.isClassLike(owner.parent) && owner.parent.name
    ? context.replace(" ", ` ${owner.parent.name.text}.`) : context;
}

/** Gives the subject that a finding message starts with. */
export function ownerSubject(owner: EffectOwner, sourceFile: ts.SourceFile): string {
  return ts.isSourceFile(owner) ? "module" : ownerContext(owner, sourceFile);
}

/** Tells if the owner builds a new object, so that its receiver is private storage. */
export function isConstruction(owner: EffectOwner): boolean {
  return ts.isConstructorDeclaration(owner) || ts.isClassLike(owner);
}

/** Tells if the owner is a generator, whose body runs when a caller enumerates it. */
export function isGenerator(owner: EffectOwner): boolean {
  return (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isMethodDeclaration(owner)) &&
    owner.asteriskToken !== undefined;
}

/** Gives a stable key for the owner. */
export function ownerKey(owner: EffectOwner): string {
  return `${owner.kind}:${owner.pos}:${owner.end}`;
}

/** Gives the module, every function with a body, and every class without an explicit constructor in the file. */
export function collectOwners(sourceFile: ts.SourceFile): EffectOwner[] {
  const owners: EffectOwner[] = [sourceFile];
  function visit(node: ts.Node): void {
    if (isFunctionLikeWithBody(node) || (ts.isClassLike(node) && !explicitConstructor(node))) {
      owners.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return owners;
}

/** Tells if the node is an instance field, whose initializer runs when the class is constructed. */
export function isInstanceField(node: ts.Node): node is ts.PropertyDeclaration {
  return ts.isPropertyDeclaration(node) && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

/** Gives the initializers of the instance fields of the class. */
export function instanceInitializers(owner: ts.ClassLikeDeclaration): ts.Expression[] {
  return owner.members.flatMap((member) => isInstanceField(member) && member.initializer ? [member.initializer] : []);
}

/** Gives the explicit constructor of the class. */
export function explicitConstructor(owner: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | undefined {
  return owner.members.find((member): member is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(member) && member.body !== undefined,
  );
}

/** Gives the expression the class extends. */
export function baseClassExpression(owner: ts.ClassLikeDeclaration): ts.Expression | undefined {
  const clause = owner.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword);
  return clause?.types[0]?.expression;
}

/** Gives the nearest class around the node. */
export function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isClassLike(current)) {
      return current;
    }
  }
  return undefined;
}
