// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import type { Finding } from "../finding";
import { findBooleanArgumentFlag } from "./boolean-argument-flag";
import { findBooleanGetMethodName } from "./boolean-get-method-name";
import { findCamelCaseClassName } from "./camel-case-class-name";
import { findCamelCaseMethodName } from "./camel-case-method-name";
import { findCamelCaseParameterName } from "./camel-case-parameter-name";
import { findCamelCasePropertyName } from "./camel-case-property-name";
import { findCamelCaseVariableName } from "./camel-case-variable-name";
import * as camelCaseClassName from "./camel-case-class-name";
import * as camelCaseMethodName from "./camel-case-method-name";
import * as camelCaseParameterName from "./camel-case-parameter-name";
import * as camelCasePropertyName from "./camel-case-property-name";
import * as camelCaseVariableName from "./camel-case-variable-name";
import * as booleanArgumentFlag from "./boolean-argument-flag";
import * as booleanGetMethodName from "./boolean-get-method-name";
import * as constantNamingConventions from "./constant-naming-conventions";
import * as constructorWithNameAsEnclosingClass from "./constructor-with-name-as-enclosing-class";
import * as countInLoopExpression from "./count-in-loop-expression";
import * as couplingBetweenObjects from "./coupling-between-objects";
import * as cyclomaticComplexity from "./cyclomatic-complexity";
import * as developmentCodeFragment from "./development-code-fragment";
import * as duplicatedArrayKey from "./duplicated-array-key";
import * as elseExpression from "./else-expression";
import * as emptyCatchBlock from "./empty-catch-block";
import * as excessiveClassComplexity from "./excessive-class-complexity";
import * as excessiveClassLength from "./excessive-class-length";
import * as excessiveMethodLength from "./excessive-method-length";
import * as excessiveParameterList from "./excessive-parameter-list";
import * as excessivePublicCount from "./excessive-public-count";
import * as exitExpression from "./exit-expression";
import * as globalVariable from "./global-variable";
import * as gotoStatement from "./goto-statement";
import * as ifStatementAssignment from "./if-statement-assignment";
import * as lackOfCohesionOfMethods from "./lack-of-cohesion-of-methods";
import * as longClassName from "./long-class-name";
import * as longVariable from "./long-variable";
import * as npathComplexity from "./npath-complexity";
import * as shortClassName from "./short-class-name";
import * as shortMethodName from "./short-method-name";
import * as shortVariable from "./short-variable";
import * as staticAccess from "./static-access";
import * as tooManyFields from "./too-many-fields";
import * as tooManyMethods from "./too-many-methods";
import * as tooManyPublicMethods from "./too-many-public-methods";
import * as unusedFormalParameter from "./unused-formal-parameter";
import * as unusedLocalVariable from "./unused-local-variable";
import * as unusedPrivateField from "./unused-private-field";
import * as unusedPrivateMethod from "./unused-private-method";
import { findConstantNamingConventions } from "./constant-naming-conventions";
import { findConstructorWithNameAsEnclosingClass } from "./constructor-with-name-as-enclosing-class";
import { findCountInLoopExpression } from "./count-in-loop-expression";
import { findCouplingBetweenObjects } from "./coupling-between-objects";
import { findCyclomaticComplexity } from "./cyclomatic-complexity";
import { findDevelopmentCodeFragment } from "./development-code-fragment";
import { findDuplicatedArrayKey } from "./duplicated-array-key";
import { findElseExpression } from "./else-expression";
import { findEmptyCatchBlock } from "./empty-catch-block";
import { findExcessiveClassComplexity } from "./excessive-class-complexity";
import { findExcessiveClassLength } from "./excessive-class-length";
import { findExcessiveMethodLength } from "./excessive-method-length";
import { findExcessiveParameterList } from "./excessive-parameter-list";
import { findExcessivePublicCount } from "./excessive-public-count";
import { findExitExpression } from "./exit-expression";
import { findGlobalVariable } from "./global-variable";
import { findGotoStatement } from "./goto-statement";
import { findIfStatementAssignment } from "./if-statement-assignment";
import { findLongClassName } from "./long-class-name";
import { findLongVariable } from "./long-variable";
import { findNPathComplexity } from "./npath-complexity";
import { findShortClassName } from "./short-class-name";
import { findShortMethodName } from "./short-method-name";
import { findShortVariable } from "./short-variable";
import { findStaticAccess } from "./static-access";
import { findTooManyFields } from "./too-many-fields";
import { findTooManyMethods } from "./too-many-methods";
import { findTooManyPublicMethods } from "./too-many-public-methods";
import { findUnusedFormalParameter } from "./unused-formal-parameter";
import { findUnusedLocalVariable } from "./unused-local-variable";
import { findUnusedPrivateField } from "./unused-private-field";
import { findUnusedPrivateMethod } from "./unused-private-method";

export type RuleProperties = Readonly<Record<string, string>>;

export type RuleSelection = {
  name: string;
  rulesetName: string;
  priority?: number;
  properties: RuleProperties;
};

export type RuleDefinition = {
  name: string;
  priority: number;
  properties: Record<string, unknown>;
  aliases?: Readonly<Record<string, string>>;
  run: (sourceFile: ts.SourceFile) => Finding[];
};

type RuleModule = {
  ruleName: string;
  priority: number;
  properties?: Readonly<Record<string, unknown>>;
  aliases?: Readonly<Record<string, string>>;
};

function moduleDefinition(
  module: RuleModule,
  find: (sourceFile: ts.SourceFile) => Finding[],
  aliases?: Readonly<Record<string, string>>,
): RuleDefinition {
  return {
    name: module.ruleName,
    priority: module.priority,
    properties: (module.properties ?? {}) as Record<string, unknown>,
    aliases,
    run: find,
  };
}

const definitions: RuleDefinition[] = [
  moduleDefinition(cyclomaticComplexity, findCyclomaticComplexity, { maximum: "reportlevel" }),
  moduleDefinition(npathComplexity, findNPathComplexity, { maximum: "minimum", reportlevel: "minimum" }),
  moduleDefinition(excessiveMethodLength, findExcessiveMethodLength, { maximum: "minimum" }),
  moduleDefinition(excessiveClassLength, findExcessiveClassLength, { maximum: "minimum" }),
  moduleDefinition(excessiveParameterList, findExcessiveParameterList, { maximum: "minimum" }),
  moduleDefinition(excessivePublicCount, findExcessivePublicCount, { maximum: "minimum" }),
  moduleDefinition(tooManyFields, findTooManyFields),
  moduleDefinition(tooManyMethods, findTooManyMethods),
  moduleDefinition(tooManyPublicMethods, findTooManyPublicMethods),
  moduleDefinition(excessiveClassComplexity, findExcessiveClassComplexity),
  moduleDefinition(shortClassName, findShortClassName),
  moduleDefinition(longClassName, findLongClassName),
  moduleDefinition(shortVariable, findShortVariable),
  moduleDefinition(longVariable, findLongVariable),
  moduleDefinition(shortMethodName, findShortMethodName),
  moduleDefinition(constantNamingConventions, findConstantNamingConventions),
  moduleDefinition(booleanGetMethodName, findBooleanGetMethodName),
  moduleDefinition(constructorWithNameAsEnclosingClass, findConstructorWithNameAsEnclosingClass),
  moduleDefinition(unusedPrivateField, findUnusedPrivateField),
  moduleDefinition(unusedLocalVariable, findUnusedLocalVariable),
  moduleDefinition(unusedPrivateMethod, findUnusedPrivateMethod),
  moduleDefinition(unusedFormalParameter, findUnusedFormalParameter),
  moduleDefinition(booleanArgumentFlag, findBooleanArgumentFlag),
  moduleDefinition(elseExpression, findElseExpression),
  moduleDefinition(staticAccess, findStaticAccess),
  moduleDefinition(ifStatementAssignment, findIfStatementAssignment),
  moduleDefinition(duplicatedArrayKey, findDuplicatedArrayKey),
  moduleDefinition(exitExpression, findExitExpression),
  moduleDefinition(gotoStatement, findGotoStatement),
  moduleDefinition(countInLoopExpression, findCountInLoopExpression),
  moduleDefinition(developmentCodeFragment, findDevelopmentCodeFragment),
  moduleDefinition(emptyCatchBlock, findEmptyCatchBlock),
  moduleDefinition(couplingBetweenObjects, findCouplingBetweenObjects, { reportlevel: "maximum" }),
  moduleDefinition(lackOfCohesionOfMethods, lackOfCohesionOfMethods.findLackOfCohesionOfMethods, { minimum: "maximum" }),
  moduleDefinition(globalVariable, (sourceFile) => []),
  moduleDefinition(camelCaseClassName, findCamelCaseClassName),
  moduleDefinition(camelCaseMethodName, findCamelCaseMethodName),
  moduleDefinition(camelCasePropertyName, findCamelCasePropertyName),
  moduleDefinition(camelCaseParameterName, findCamelCaseParameterName),
  moduleDefinition(camelCaseVariableName, findCamelCaseVariableName),
];

const definitionsByName = new Map(definitions.map((definition) => [definition.name.toLowerCase(), definition]));

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
      runtime[actual] = propertyValue(value, runtime[actual]);
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

function applyPriority(findings: Finding[], priority: number | undefined): Finding[] {
  if (priority === undefined) {
    return findings;
  }
  return findings.map((finding) => ({ ...finding, priority }));
}

export function runRule(definition: RuleDefinition, selection: RuleSelection, sourceFile: ts.SourceFile): Finding[] {
  return withConfiguredProperties(definition, selection.properties, () =>
    applyPriority(definition.run(sourceFile), selection.priority ?? definition.priority),
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
