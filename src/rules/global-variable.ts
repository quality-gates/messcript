// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { isFunctionLike } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { createDesignFinding } from "./design-finding";

export const ruleName = "GlobalVariable";
export const priority = 1;
export const properties = { "report-immutable": false } as const;

type Binding = {
  name: string;
  node: ts.Identifier;
  sourceFile: ts.SourceFile;
  mutable: boolean;
};

type StaticField = {
  name: string;
  node: ts.PropertyDeclaration;
  sourceFile: ts.SourceFile;
  className: string;
  mutable: boolean;
};

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: readonly ts.Modifier[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  const identifiers: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      identifiers.push(...bindingIdentifiers(element.name));
    }
  }
  return identifiers;
}

function nearestScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current) || ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isExternalModule(sourceFile: ts.SourceFile): boolean {
  return Boolean((sourceFile as ts.SourceFile & { externalModuleIndicator?: ts.Node }).externalModuleIndicator);
}

function enclosingClass(node: ts.Node): ts.ClassDeclaration | ts.ClassExpression | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function className(node: ts.ClassDeclaration | ts.ClassExpression): string | undefined {
  if (node.name) {
    return node.name.text;
  }
  if (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function isModuleBinding(node: ts.VariableDeclaration): boolean {
  return !enclosingFunction(node) && !enclosingClass(node);
}

function isDeclarationOnly(node: ts.VariableDeclaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableStatement(current)) {
      return hasModifier(current, ts.SyntaxKind.DeclareKeyword);
    }
    current = current.parent;
  }
  return false;
}

function variableKind(node: ts.VariableDeclaration): "let" | "var" | "const" {
  const declarationList = node.parent;
  if (!ts.isVariableDeclarationList(declarationList)) {
    return "var";
  }
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) {
    return "const";
  }
  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) {
    return "let";
  }
  return "var";
}

function collectBindings(sourceFile: ts.SourceFile): Binding[] {
  const bindings: Binding[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && isModuleBinding(node) && !isDeclarationOnly(node)) {
      const kind = variableKind(node);
      for (const identifier of bindingIdentifiers(node.name)) {
        bindings.push({
          name: identifier.text,
          node: identifier,
          sourceFile,
          mutable: kind !== "const",
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function staticFieldName(node: ts.PropertyDeclaration, sourceFile: ts.SourceFile): string | undefined {
  if (!node.name || ts.isComputedPropertyName(node.name)) {
    return undefined;
  }
  return node.name.getText(sourceFile);
}

function collectStaticFields(sourceFile: ts.SourceFile): StaticField[] {
  const fields: StaticField[] = [];
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (!enclosingFunction(node)) {
        const owner = className(node);
        if (owner) {
          for (const member of node.members) {
            if (!ts.isPropertyDeclaration(member) || !hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
              continue;
            }
            const name = staticFieldName(member, sourceFile);
            if (!name) {
              continue;
            }
            fields.push({
              name,
              node: member,
              sourceFile,
              className: owner,
              mutable: !hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return fields;
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(kind);
}

function updateOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken;
}

function propertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function receiverName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  return undefined;
}

function staticReceiver(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): { className: string; fieldName: string } | undefined {
  const receiver = receiverName(node.expression);
  const fieldName = propertyName(node);
  return receiver && fieldName ? { className: receiver, fieldName } : undefined;
}

function staticThisReceiver(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
): { className: string; fieldName: string } | undefined {
  if (node.expression.kind !== ts.SyntaxKind.ThisKeyword) {
    return undefined;
  }
  const functionNode = enclosingFunction(node);
  if (!functionNode || !hasModifier(functionNode, ts.SyntaxKind.StaticKeyword)) {
    return undefined;
  }
  const owner = enclosingClass(node);
  const ownerName = owner && className(owner);
  const fieldName = propertyName(node);
  return ownerName && fieldName ? { className: ownerName, fieldName } : undefined;
}

function targetScopes(node: ts.Node, functionNode: FunctionLike): ts.Node[] {
  const scopes: ts.Node[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current) || ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) {
      scopes.push(current);
    }
    if (current === functionNode) {
      break;
    }
    current = current.parent;
  }
  scopes.push(functionNode.getSourceFile());
  return scopes;
}

function localBindingVisible(name: string, target: ts.Node, functionNode: FunctionLike): boolean {
  const scopes = targetScopes(target, functionNode);
  for (const parameter of functionNode.parameters) {
    if (bindingIdentifiers(parameter.name).some((identifier) => identifier.text === name)) {
      return true;
    }
  }
  if (!functionNode.body) {
    return false;
  }
  let visible = false;
  function visit(node: ts.Node): void {
    if (visible || (node !== functionNode.body && isFunctionLike(node))) {
      return;
    }
    if (ts.isVariableDeclaration(node) && bindingIdentifiers(node.name).some((identifier) => identifier.text === name)) {
      const scope = variableKind(node) === "var" ? functionNode : nearestScope(node.name);
      visible = scopes.includes(scope);
      if (visible) {
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(functionNode.body);
  return visible;
}

function globalBindingFor(name: string, node: ts.Node, bindings: readonly Binding[]): Binding | undefined {
  const candidates = bindings.filter((binding) => binding.name === name);
  if (!enclosingFunction(node)) {
    return candidates.find((binding) =>
      binding.sourceFile === node.getSourceFile() ||
      (!isExternalModule(binding.sourceFile) && !isExternalModule(node.getSourceFile())),
    );
  }
  const functionNode = enclosingFunction(node);
  if (!functionNode) {
    return undefined;
  }
  const targetScopeNodes = targetScopes(node, functionNode);
  const functionSource = functionNode.getSourceFile();
  return candidates.find((binding) => {
    const sameSource = binding.sourceFile === functionSource;
    const sharedScript = !isExternalModule(binding.sourceFile) && !isExternalModule(functionSource);
    if (!sameSource && !sharedScript) {
      return false;
    }
    if (sameSource && localBindingVisible(name, node, functionNode)) {
      return false;
    }
    const bindingScope = nearestScope(binding.node);
    return targetScopeNodes.includes(bindingScope);
  });
}

const mutatingMethods = new Set(["add", "delete", "fill", "pop", "push", "reverse", "set", "shift", "sort", "splice", "unshift"]);

function markBindingMutation(node: ts.Node, name: string, bindings: readonly Binding[], mutated: Set<Binding>): void {
  const binding = globalBindingFor(name, node, bindings);
  if (binding) {
    mutated.add(binding);
  }
}

function markPropertyMutation(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
  bindings: readonly Binding[],
  fields: readonly StaticField[],
  mutatedBindings: Set<Binding>,
  mutatedFields: Set<StaticField>,
): void {
  const receiver = receiverName(node.expression);
  if (receiver) {
    markBindingMutation(node, receiver, bindings, mutatedBindings);
    const qualified = staticReceiver(node);
    if (qualified) {
      for (const field of fields) {
        if (field.className === qualified.className && field.name === qualified.fieldName) {
          mutatedFields.add(field);
        }
      }
    }
  }
  const staticThis = staticThisReceiver(node, sourceFile);
  if (staticThis) {
    for (const field of fields) {
      if (field.className === staticThis.className && field.name === staticThis.fieldName) {
        mutatedFields.add(field);
      }
    }
  }
}

function observeMutations(
  sourceFile: ts.SourceFile,
  bindings: readonly Binding[],
  fields: readonly StaticField[],
  mutatedBindings: Set<Binding>,
  mutatedFields: Set<StaticField>,
): void {
  // messcript-disable-next-line CyclomaticComplexity NPathComplexity
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left)) {
        markBindingMutation(node.left, node.left.text, bindings, mutatedBindings);
      } else if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
        markPropertyMutation(node.left, sourceFile, bindings, fields, mutatedBindings, mutatedFields);
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && updateOperator(node.operator)) {
      const operand = node.operand;
      if (ts.isIdentifier(operand)) {
        markBindingMutation(operand, operand.text, bindings, mutatedBindings);
      } else if (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) {
        markPropertyMutation(operand, sourceFile, bindings, fields, mutatedBindings, mutatedFields);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text.toLowerCase();
      if (mutatingMethods.has(method)) {
        const receiver = node.expression.expression;
        if (ts.isIdentifier(receiver)) {
          markBindingMutation(node, receiver.text, bindings, mutatedBindings);
        } else if (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
          markPropertyMutation(receiver, sourceFile, bindings, fields, mutatedBindings, mutatedFields);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "assign") {
      const target = node.arguments[0];
      if (target && ts.isIdentifier(target)) {
        markBindingMutation(target, target.text, bindings, mutatedBindings);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

export function findGlobalVariable(
  sourceFiles: readonly ts.SourceFile[],
  reportImmutable = properties["report-immutable"],
): Finding[] {
  const bindings = sourceFiles.flatMap((sourceFile) => collectBindings(sourceFile));
  const fields = sourceFiles.flatMap((sourceFile) => collectStaticFields(sourceFile));
  const mutatedBindings = new Set<Binding>();
  const mutatedFields = new Set<StaticField>();
  for (const sourceFile of sourceFiles) {
    observeMutations(sourceFile, bindings, fields, mutatedBindings, mutatedFields);
  }

  const findings: Finding[] = [];
  for (const binding of bindings) {
    if ((binding.mutable && mutatedBindings.has(binding)) || reportImmutable) {
      findings.push(
        createDesignFinding(
          binding.node,
          binding.sourceFile,
          ruleName,
          priority,
          `global variable ${binding.name}`,
          `Avoid using static mutable state: ${binding.name}.`,
        ),
      );
    }
  }
  for (const field of fields) {
    if ((field.mutable && mutatedFields.has(field)) || reportImmutable) {
      findings.push(
        createDesignFinding(
          field.node,
          field.sourceFile,
          ruleName,
          priority,
          `static field ${field.name}`,
          `Avoid using static mutable state: ${field.name}.`,
        ),
      );
    }
  }
  return findings;
}
