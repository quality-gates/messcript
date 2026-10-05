// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import type { Finding } from "../finding";
import { validateIgnorePatternProperty } from "./ignore-pattern";
import { definition as booleanArgumentFlag } from "./boolean-argument-flag";
import { definition as booleanGetMethodName } from "./boolean-get-method-name";
import { definition as camelCaseClassName } from "./camel-case-class-name";
import { definition as camelCaseMethodName } from "./camel-case-method-name";
import { definition as camelCaseParameterName } from "./camel-case-parameter-name";
import { definition as camelCasePropertyName } from "./camel-case-property-name";
import { definition as camelCaseVariableName } from "./camel-case-variable-name";
import { definition as constantNamingConventions } from "./constant-naming-conventions";
import { definition as constructorWithNameAsEnclosingClass } from "./constructor-with-name-as-enclosing-class";
import { definition as countInLoopExpression } from "./count-in-loop-expression";
import { definition as couplingBetweenObjects } from "./coupling-between-objects";
import { definition as cyclomaticComplexity } from "./cyclomatic-complexity";
import { definition as developmentCodeFragment } from "./development-code-fragment";
import { definition as duplicatedArrayKey } from "./duplicated-array-key";
import { definition as elseExpression } from "./else-expression";
import { definition as emptyCatchBlock } from "./empty-catch-block";
import { definition as excessiveClassComplexity } from "./excessive-class-complexity";
import { definition as excessiveClassLength } from "./excessive-class-length";
import { definition as excessiveMethodLength } from "./excessive-method-length";
import { definition as excessiveParameterList } from "./excessive-parameter-list";
import { definition as excessivePublicCount } from "./excessive-public-count";
import { definition as exitExpression } from "./exit-expression";
import { definition as globalVariable, findGlobalVariable } from "./global-variable";
import { definition as gotoStatement } from "./goto-statement";
import { definition as ifStatementAssignment } from "./if-statement-assignment";
import { definition as implicitInput } from "./implicit-input";
import { definition as implicitOutput } from "./implicit-output";
import { definition as lackOfCohesionOfMethods } from "./lack-of-cohesion-of-methods";
import { definition as longClassName } from "./long-class-name";
import { definition as longVariable } from "./long-variable";
import { definition as npathComplexity } from "./npath-complexity";
import { definition as shortClassName } from "./short-class-name";
import { definition as shortMethodName } from "./short-method-name";
import { definition as shortVariable } from "./short-variable";
import { definition as staticAccess } from "./static-access";
import { definition as tooManyFields } from "./too-many-fields";
import { definition as tooManyMethods } from "./too-many-methods";
import { definition as tooManyPublicMethods } from "./too-many-public-methods";
import { definition as unusedFormalParameter } from "./unused-formal-parameter";
import { definition as unusedLocalVariable } from "./unused-local-variable";
import { definition as unusedPrivateField } from "./unused-private-field";
import { definition as unusedPrivateMethod } from "./unused-private-method";

export type RuleProperties = Readonly<Record<string, string>>;

export type RuleSelection = {
  name: string;
  rulesetName: string;
  priority?: number;
  properties: RuleProperties;
};

/** Per-file facts a run decides once, so every rule sees the same answer. */
export type RuleContext = {
  /** Whether discovery classified the file as a test file relative to its scan root. */
  isTestFile: boolean;
};

export type RuleDefinition = {
  name: string;
  priority: number;
  properties: Record<string, unknown>;
  aliases?: Readonly<Record<string, string>>;
  run: (sourceFile: ts.SourceFile, context: RuleContext) => Finding[];
};

/** Index definitions by case-folded name, refusing two rules that would answer to one name. */
export function indexRuleDefinitions(definitions: readonly RuleDefinition[]): ReadonlyMap<string, RuleDefinition> {
  const index = new Map<string, RuleDefinition>();
  for (const definition of definitions) {
    const key = definition.name.toLowerCase();
    if (index.has(key)) {
      throw new Error(`Duplicate rule definition: ${key}`);
    }
    index.set(key, definition);
  }
  return index;
}

const definitionsByName = indexRuleDefinitions([
  cyclomaticComplexity,
  npathComplexity,
  excessiveMethodLength,
  excessiveClassLength,
  excessiveParameterList,
  excessivePublicCount,
  tooManyFields,
  tooManyMethods,
  tooManyPublicMethods,
  excessiveClassComplexity,
  shortClassName,
  longClassName,
  shortVariable,
  longVariable,
  shortMethodName,
  constantNamingConventions,
  booleanGetMethodName,
  constructorWithNameAsEnclosingClass,
  unusedPrivateField,
  unusedLocalVariable,
  unusedPrivateMethod,
  unusedFormalParameter,
  booleanArgumentFlag,
  elseExpression,
  staticAccess,
  ifStatementAssignment,
  duplicatedArrayKey,
  exitExpression,
  gotoStatement,
  countInLoopExpression,
  developmentCodeFragment,
  emptyCatchBlock,
  couplingBetweenObjects,
  lackOfCohesionOfMethods,
  globalVariable,
  camelCaseClassName,
  camelCaseMethodName,
  camelCasePropertyName,
  camelCaseParameterName,
  camelCaseVariableName,
  implicitInput,
  implicitOutput,
]);

const componentRulesetBase: Readonly<Record<string, readonly string[]>> = {
  codesize: [
    "CyclomaticComplexity", "NPathComplexity", "ExcessiveMethodLength", "ExcessiveClassLength",
    "ExcessiveParameterList", "ExcessivePublicCount", "TooManyFields", "TooManyMethods",
    "TooManyPublicMethods", "ExcessiveClassComplexity",
  ],
  naming: [
    "ShortClassName", "LongClassName", "ShortVariable", "LongVariable", "ShortMethodName",
    "ConstantNamingConventions", "BooleanGetMethodName", "ConstructorWithNameAsEnclosingClass",
  ],
  unusedcode: ["UnusedPrivateField", "UnusedLocalVariable", "UnusedPrivateMethod", "UnusedFormalParameter"],
  cleancode: ["BooleanArgumentFlag", "ElseExpression", "StaticAccess", "IfStatementAssignment", "DuplicatedArrayKey"],
  design: [
    "ExitExpression", "GotoStatement", "CountInLoopExpression", "DevelopmentCodeFragment", "EmptyCatchBlock",
    "CouplingBetweenObjects", "GlobalVariable", "LackOfCohesionOfMethods",
  ],
  controversial: [
    "CamelCaseClassName", "CamelCaseMethodName", "CamelCasePropertyName", "CamelCaseParameterName", "CamelCaseVariableName",
  ],
};

const opinionatedRules = [
  "ShortVariable", "UnusedFormalParameter", "BooleanArgumentFlag", "ElseExpression",
  "StaticAccess", "CountInLoopExpression", "ExitExpression",
] as const;

export const typescriptPolicyExceptions = [
  "declarations", "overloads", "accessibility", "parameter-properties",
  "enums", "namespaces", "type-only",
] as const;

const recommendedRules = Object.values(componentRulesetBase)
  .flat()
  .filter((ruleName) => !opinionatedRules.some((excluded) => excluded.toLowerCase() === ruleName.toLowerCase()));

export const languagePolicies = {
  javascript: { rules: recommendedRules, longVariableMaximum: 35, exceptions: [] as const },
  typescript: { rules: recommendedRules, longVariableMaximum: 35, exceptions: typescriptPolicyExceptions },
} as const;

export const componentRulesets: Readonly<Record<string, readonly string[]>> = {
  ...componentRulesetBase,
  javascript: languagePolicies.javascript.rules,
  typescript: languagePolicies.typescript.rules,
  opinionated: opinionatedRules,
  explicitness: ["ImplicitInput", "ImplicitOutput"],
};

export function getRuleDefinition(name: string): RuleDefinition | undefined {
  return definitionsByName.get(name.trim().toLowerCase());
}

export function canonicalPropertyName(ruleName: string, propertyName: string): string {
  const definition = getRuleDefinition(ruleName);
  const normalized = propertyName.trim().toLowerCase();
  const alias = definition?.aliases?.[normalized] ?? normalized;
  const actual = definition && Object.keys(definition.properties).find((key) => key.toLowerCase() === alias);
  return actual ?? alias;
}

function propertyValue(value: string, current: unknown): unknown {
  if (typeof current === "boolean") {
    return value.trim().toLowerCase() === "true";
  }
  if (typeof current === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : current;
  }
  return value;
}

function withConfiguredProperties<T>(definition: RuleDefinition, properties: RuleProperties, callback: () => T): T {
  const runtime = definition.properties;
  const original = new Map(Object.entries(runtime));
  for (const [name, value] of Object.entries(properties)) {
    const canonical = canonicalPropertyName(definition.name, name);
    const actual = Object.keys(runtime).find((key) => key.toLowerCase() === canonical.toLowerCase());
    if (actual) {
      const nextValue = propertyValue(value, runtime[actual]);
      if (typeof nextValue === "string") {
        validateIgnorePatternProperty(actual, nextValue);
      }
      runtime[actual] = nextValue;
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of original) {
      runtime[key] = value;
    }
  }
}

/** Validate selection properties that must be safe before analysis. */
export function validateSelectionProperties(selection: RuleSelection): void {
  for (const [name, value] of Object.entries(selection.properties)) {
    validateIgnorePatternProperty(name, value);
  }
}

function applyPriority(findings: Finding[], priority: number | undefined): Finding[] {
  if (priority === undefined) {
    return findings;
  }
  return findings.map((finding) => ({ ...finding, priority }));
}

export function runRule(
  definition: RuleDefinition,
  selection: RuleSelection,
  sourceFile: ts.SourceFile,
  context: RuleContext,
): Finding[] {
  return withConfiguredProperties(definition, selection.properties, () =>
    applyPriority(definition.run(sourceFile, context), selection.priority ?? definition.priority),
  );
}

export function runGlobalVariable(
  definition: RuleDefinition,
  selection: RuleSelection,
  sourceFiles: readonly ts.SourceFile[],
): Finding[] {
  return withConfiguredProperties(definition, selection.properties, () =>
    applyPriority(
      findGlobalVariable(sourceFiles),
      selection.priority ?? definition.priority,
    ),
  );
}
