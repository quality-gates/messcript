import ts from "typescript";
import { outerExpression, unwrapExpression } from "../ast/expressions";
import { arrayIndexForSlot } from "./storage";

export type ReadMode = "reference" | "keys" | "slots" | "deep";
export type ReadSite = { readonly path: readonly string[]; readonly mode: ReadMode };

export type ArgumentSites = (
  site: ts.CallExpression | ts.NewExpression | ts.AccessExpression, index: number | "this",
) => ReadSite[] | undefined;

export function readSites(node: ts.Expression, argumentSites: ArgumentSites): ReadSite[] {
  const { path, expression } = selectedRead(node);
  if (path.length > 0 && isAssignedTarget(expression)) {
    return [{ path: path.slice(0, -1), mode: "reference" }];
  }
  return consumerSites(expression, argumentSites).map((site) => ({ path: [...path, ...site.path], mode: site.mode }));
}

export function writeAffectsRead(site: ReadSite, prefix: readonly string[], slot: string | undefined): boolean {
  if (!pathsOverlap(site.path, prefix)) {
    return false;
  }
  if (site.path.length <= prefix.length) {
    return !(site.mode === "reference");
  }
  return slot === undefined || slotOverlaps(site.path.slice(prefix.length), slot);
}

export function storageSlot(target: ts.AccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(target)) {
    return `property:${target.name.text}`;
  }
  const key = unwrapExpression(target.argumentExpression);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? `property:${key.text}` : undefined;
}

function slotOverlaps(path: readonly string[], slot: string): boolean {
  if (slot.startsWith("append:")) {
    const selected = path[0];
    if (selected === undefined || selected === "*") {
      return true;
    }
    const index = arrayIndexForSlot(selected);
    return index !== undefined && index >= Number(slot.slice(7));
  }
  return pathsOverlap(path, [slot]);
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.slice(0, Math.min(left.length, right.length)).every((slot, index) =>
    slot === right[index] || slot === "*" || right[index] === "*");
}

export function selectedRead(node: ts.Expression): { path: string[]; expression: ts.Expression } {
  const path: string[] = [];
  let current: ts.Expression = outerExpression(node);
  for (;;) {
    const parent = current.parent;
    if (isChosenValue(parent, current)) {
      current = outerExpression(parent);
      continue;
    }
    if (!(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) || parent.expression !== current ||
        receiverCall(current)) {
      return { path, expression: current };
    }
    path.push(storageSlot(parent) ?? "*");
    current = outerExpression(parent);
  }
}

function isChosenValue(parent: ts.Node, expression: ts.Expression): parent is ts.Expression {
  if (ts.isConditionalExpression(parent)) {
    return parent.condition !== expression;
  }
  return ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.AmpersandAmpersandToken].includes(parent.operatorToken.kind);
}

function isAssignedTarget(expression: ts.Expression): boolean {
  const parent = expression.parent;
  return (ts.isBinaryExpression(parent) && parent.left === expression && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    ts.isDeleteExpression(parent);
}

const CONTENTS: ReadSite[] = [{ path: [], mode: "slots" }];
const REFERENCE: ReadSite[] = [{ path: [], mode: "reference" }];

function consumerSites(expression: ts.Expression, argumentSites: ArgumentSites): ReadSite[] {
  const parent = expression.parent;
  if (holdsReference(parent, expression)) {
    return [...REFERENCE, ...literalMemberSites(parent, expression, argumentSites)];
  }
  if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
    return ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent) ? [{ path: ["*"], mode: "slots" }]
      : readSites(parent.parent, argumentSites).map((site) => ({ path: ["*", ...site.path.slice(1)], mode: site.mode }));
  }
  const name = initializedName(parent, expression);
  if (name) {
    return bindingNameSites(name);
  }
  if (ts.isBinaryExpression(parent)) {
    return binarySites(parent, expression, argumentSites);
  }
  return callSites(expression, argumentSites) ?? CONTENTS;
}

function callSites(expression: ts.Expression, argumentSites: ArgumentSites): ReadSite[] | undefined {
  const parent = expression.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== expression) {
    return argumentSites(parent, parent.arguments?.indexOf(expression) ?? -1);
  }
  const call = receiverCall(expression);
  return call && argumentSites(call, "this");
}

function holdsReference(parent: ts.Node, expression: ts.Expression): boolean {
  return ts.isArrayLiteralExpression(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isReturnStatement(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === expression) || (ts.isArrowFunction(parent) && parent.body === expression);
}

function literalMemberSites(parent: ts.Node, expression: ts.Expression, argumentSites: ArgumentSites): ReadSite[] {
  const held = heldMember(parent, expression);
  return held ? readSites(held.literal, argumentSites).flatMap((site): ReadSite[] => {
    if (site.path.length === 0) {
      return site.mode === "deep" ? [{ path: [], mode: "deep" }] : [];
    }
    return slotOverlaps(site.path, held.slot) ? [{ path: site.path.slice(1), mode: site.mode }] : [];
  }) : [];
}

function heldMember(parent: ts.Node, expression: ts.Expression): { literal: ts.Expression; slot: string } | undefined {
  if (ts.isArrayLiteralExpression(parent)) {
    return { literal: parent, slot: elementSlot(parent, expression) };
  }
  return (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && ts.isObjectLiteralExpression(parent.parent)
    ? { literal: parent.parent, slot: keySlot(parent.name) } : undefined;
}

function elementSlot(literal: ts.ArrayLiteralExpression, element: ts.Expression): string {
  const index = literal.elements.indexOf(element);
  const prefix = literal.elements.slice(0, index);
  return prefix.some(ts.isSpreadElement) ? `append:${prefix.filter((element) => !ts.isSpreadElement(element)).length}` : `property:${index}`;
}

function initializedName(parent: ts.Node, expression: ts.Expression): ts.BindingName | undefined {
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.initializer === expression
    ? parent.name
    : undefined;
}

export function receiverCall(expression: ts.Expression): ts.CallExpression | undefined {
  const member = expression.parent;
  if (!(ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) || member.expression !== expression) {
    return undefined;
  }
  const callee = outerExpression(member);
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee ? callee.parent : undefined;
}

function binarySites(parent: ts.BinaryExpression, expression: ts.Expression, argumentSites: ArgumentSites): ReadSite[] {
  const operator = parent.operatorToken.kind;
  if (parent.right === expression && (operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken || operator === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
    return assignmentTargetSites(parent.left, argumentSites);
  }
  return operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ? REFERENCE : CONTENTS;
}

function bindingNameSites(name: ts.BindingName): ReadSite[] {
  if (ts.isIdentifier(name)) {
    return REFERENCE;
  }
  if (ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap((element) => {
      const key = element.propertyName ?? element.name;
      return element.dotDotDotToken ? [{ path: ["*"], mode: "reference" }] : nested(keySlot(key), bindingNameSites(element.name));
    });
  }
  return name.elements.flatMap((element, index) => ts.isOmittedExpression(element) ? []
    : nested(element.dotDotDotToken ? "*" : `property:${index}`, bindingNameSites(element.name)));
}

function assignmentTargetSites(target: ts.Expression, argumentSites: ArgumentSites): ReadSite[] {
  const value = unwrapExpression(target);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) {
        return [{ path: ["*"], mode: "reference" }];
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return [{ path: [`property:${property.name.text}`], mode: "reference" }];
      }
      return ts.isPropertyAssignment(property) ? nested(keySlot(property.name), assignmentTargetSites(defaulted(property.initializer), argumentSites))
        : CONTENTS;
    });
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) {
        return [];
      }
      return ts.isSpreadElement(element) ? nested("*", assignmentTargetSites(element.expression, argumentSites))
        : nested(`property:${index}`, assignmentTargetSites(defaulted(element), argumentSites));
    });
  }
  return ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) ? argumentSites(value, 0) ?? CONTENTS : REFERENCE;
}

function defaulted(target: ts.Expression): ts.Expression {
  return ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken ? target.left : target;
}

function nested(slot: string, sites: ReadSite[]): ReadSite[] {
  return sites.map((site) => ({ path: [slot, ...site.path], mode: site.mode }));
}

function keySlot(key: ts.Node): string {
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? `property:${key.text}` : "*";
}
