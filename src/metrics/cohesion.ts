// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import {
  getClassFields,
  getClassMethods,
  type ClassField,
  type ClassLike,
  type ClassMethod,
} from "../ast/classes";

type Scope = "instance" | "static";

type Field = {
  key: string;
};

type Method = {
  index: number;
  node: ClassMethod;
  scope: Scope;
  backingField?: string;
  propertyAccessor: boolean;
};

type Receiver = "this" | "class" | "bare";

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: readonly ts.Modifier[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function nameText(name: ts.PropertyName | ts.BindingName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name || ts.isComputedPropertyName(name)) {
    return undefined;
  }
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) {
    return name.getText(sourceFile);
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function fieldName(field: ClassField, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isParameter(field)) {
    return ts.isIdentifier(field.name) ? field.name.text : undefined;
  }
  return nameText(field.name, sourceFile);
}

function methodName(method: ClassMethod, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(method)) {
    return "constructor";
  }
  return nameText(method.name, sourceFile);
}

function scopeFor(node: ts.Node): Scope {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static" : "instance";
}

function scopedKey(scope: Scope, name: string): string {
  return `${scope}:${name}`;
}

function isThisExpression(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function literalMemberName(node: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}

// messcript-disable-next-line CyclomaticComplexity
function directReceiverMember(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): { receiver: Receiver; name: string } | undefined {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = unwrapExpression(expression.expression);
    if (isThisExpression(receiver)) {
      return { receiver: "this", name: nameText(expression.name, sourceFile) ?? expression.name.getText(sourceFile) };
    }
    if (ts.isIdentifier(receiver)) {
      return { receiver: "class", name: nameText(expression.name, sourceFile) ?? expression.name.getText(sourceFile) };
    }
  }
  if (ts.isElementAccessExpression(expression)) {
    const name = expression.argumentExpression && literalMemberName(expression.argumentExpression, sourceFile);
    if (!name) {
      return undefined;
    }
    const receiver = unwrapExpression(expression.expression);
    if (isThisExpression(receiver)) {
      return { receiver: "this", name };
    }
    if (ts.isIdentifier(receiver)) {
      return { receiver: "class", name };
    }
  }
  return undefined;
}

// messcript-disable-next-line CyclomaticComplexity
function directFieldAccess(
  expression: ts.Expression,
  methodScope: Scope,
  fields: ReadonlyMap<string, Field>,
  className: string | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  const member = directReceiverMember(expression, sourceFile);
  if (member) {
    const scope = member.receiver === "this" ? methodScope : "static";
    if (member.receiver === "class" && member.name !== className && className) {
      return undefined;
    }
    if (member.receiver === "class" && methodScope !== "static") {
      return undefined;
    }
    return fields.get(scopedKey(scope, member.name))?.key;
  }
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return fields.get(scopedKey(methodScope, unwrapped.text))?.key;
  }
  return undefined;
}

function isSimpleAccessorValue(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  return ts.isIdentifier(expression) || ts.isLiteralExpression(expression);
}

function trivialAccessorField(
  method: ClassMethod,
  methodScope: Scope,
  fields: ReadonlyMap<string, Field>,
  className: string | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (ts.isConstructorDeclaration(method) || !method.body || method.body.statements.length !== 1) {
    return undefined;
  }

  const statement = method.body.statements[0];
  if (ts.isReturnStatement(statement) && statement.expression) {
    return directFieldAccess(statement.expression, methodScope, fields, className, sourceFile);
  }
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
    return undefined;
  }
  if (statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return undefined;
  }
  if (!isSimpleAccessorValue(statement.expression.right)) {
    return undefined;
  }
  return directFieldAccess(statement.expression.left, methodScope, fields, className, sourceFile);
}

function collectDeclaredNames(method: ClassMethod): Set<string> {
  const names = new Set<string>();
  for (const parameter of method.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      names.add(parameter.name.text);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  if (method.body) {
    visit(method.body);
  }
  return names;
}

function classNameFor(node: ClassLike, sourceFile: ts.SourceFile): string | undefined {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function indexFields(node: ClassLike, sourceFile: ts.SourceFile): Map<string, Field> {
  const fields = new Map<string, Field>();
  for (const member of getClassFields(node)) {
    const name = fieldName(member, sourceFile);
    if (!name) {
      continue;
    }
    const scope: Scope = ts.isPropertyDeclaration(member) ? scopeFor(member) : "instance";
    const field = { key: scopedKey(scope, name) };
    fields.set(field.key, field);
  }
  return fields;
}

function indexMethods(
  node: ClassLike,
  fields: ReadonlyMap<string, Field>,
  className: string | undefined,
  sourceFile: ts.SourceFile,
): { methods: Method[]; byKey: Map<string, Method> } {
  const methods: Method[] = [];
  const byKey = new Map<string, Method>();
  for (const member of getClassMethods(node)) {
    if (!member.body) {
      continue;
    }
    const name = methodName(member, sourceFile);
    if (!name) {
      continue;
    }
    const scope = scopeFor(member);
    const method: Method = {
      index: methods.length,
      node: member,
      scope,
      propertyAccessor: ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member),
    };
    method.backingField = trivialAccessorField(member, scope, fields, className, sourceFile);
    methods.push(method);
    byKey.set(scopedKey(scope, name), method);
  }
  return { methods, byKey };
}

// messcript-disable-next-line ExcessiveMethodLength
function collectUses(
  method: Method,
  fields: ReadonlyMap<string, Field>,
  methods: ReadonlyMap<string, Method>,
  className: string | undefined,
  sourceFile: ts.SourceFile,
): { fields: Set<string>; calls: Set<Method> } {
  const usedFields = new Set<string>();
  const calledMethods = new Set<Method>();
  const declaredNames = collectDeclaredNames(method.node);

  function addField(expression: ts.Expression): void {
    const field = directFieldAccess(expression, method.scope, fields, className, sourceFile);
    if (field) {
      usedFields.add(field);
    }
  }

  function addAccessorOrMethod(receiver: Receiver, name: string): void {
    if (receiver === "class" && method.scope !== "static") {
      return;
    }
    const scope = receiver === "this" || receiver === "bare" ? method.scope : "static";
    const target = methods.get(scopedKey(scope, name));
    if (!target) {
      const field = fields.get(scopedKey(scope, name));
      if (field) {
        usedFields.add(field.key);
      }
      return;
    }
    if (target.backingField) {
      usedFields.add(target.backingField);
    } else {
      calledMethods.add(target);
    }
  }

  // messcript-disable-next-line CyclomaticComplexity NPathComplexity
  function visit(node: ts.Node): void {
    if (node !== method.node && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    if (ts.isTypeNode(node)) {
      return;
    }

    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (ts.isIdentifier(expression)) {
        if (!declaredNames.has(expression.text)) {
          addAccessorOrMethod("bare", expression.text);
        }
      } else {
        const member = directReceiverMember(expression, sourceFile);
        if (member) {
          addAccessorOrMethod(member.receiver, member.name);
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = directReceiverMember(node, sourceFile);
      if (member) {
        addField(node);
        if (member.receiver === "class" && method.scope !== "static") {
          return;
        }
        const scope = member.receiver === "this" || member.receiver === "bare" ? method.scope : "static";
        const target = methods.get(scopedKey(scope, member.name));
        if (target?.propertyAccessor && target.backingField) {
          usedFields.add(target.backingField);
        }
      }
    }

    if (ts.isIdentifier(node) && !declaredNames.has(node.text)) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
        (ts.isSetAccessorDeclaration(parent) && parent.name === node);
      if (!isMemberName) {
        const field = fields.get(scopedKey(method.scope, node.text));
        if (field) {
          usedFields.add(field.key);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  if (method.node.body) {
    visit(method.node.body);
  }
  return { fields: usedFields, calls: calledMethods };
}

class UnionFind {
  private readonly parents: number[];
  private readonly active: boolean[];
  private readonly fieldOwners = new Map<string, number>();

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
    this.active = Array.from({ length: size }, () => false);
  }

  addFieldUse(method: number, field: string): void {
    this.active[method] = true;
    const owner = this.fieldOwners.get(field);
    if (owner === undefined) {
      this.fieldOwners.set(field, method);
      return;
    }
    this.union(method, owner);
  }

  addCall(caller: number, callee: number): void {
    this.active[caller] = true;
    this.active[callee] = true;
    this.union(caller, callee);
  }

  countComponents(): number {
    const roots = new Set<number>();
    for (let index = 0; index < this.active.length; index += 1) {
      if (this.active[index]) {
        roots.add(this.find(index));
      }
    }
    return roots.size || 1;
  }

  private union(left: number, right: number): void {
    this.parents[this.find(left)] = this.find(right);
  }

  private find(index: number): number {
    let current = index;
    while (this.parents[current] !== current) {
      this.parents[current] = this.parents[this.parents[current]];
      current = this.parents[current];
    }
    return current;
  }
}

export function calculateLcom4(node: ClassLike): number {
  const sourceFile = node.getSourceFile();
  const fields = indexFields(node, sourceFile);
  const className = classNameFor(node, sourceFile);
  const indexed = indexMethods(node, fields, className, sourceFile);
  const graph = new UnionFind(indexed.methods.length);

  for (const method of indexed.methods) {
    if (method.backingField) {
      continue;
    }
    const uses = collectUses(method, fields, indexed.byKey, className, sourceFile);
    for (const field of uses.fields) {
      graph.addFieldUse(method.index, field);
    }
    for (const callee of uses.calls) {
      if (!callee.backingField) {
        graph.addCall(method.index, callee.index);
      }
    }
  }

  return graph.countComponents();
}

export const calculateLackOfCohesionOfMethods = calculateLcom4;
