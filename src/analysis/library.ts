import ts from "typescript";
import { methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { globalName, globalObjectMember } from "../ast/global-reference";
import type { ScopeModel } from "../ast/scopes";
import { standardMethod } from "./standard-receivers";

/**
 * What a standard library call returns.
 * Fresh storage holds nothing the caller can reach. A shallow copy holds what the receiver holds. An element is
 * storage the receiver holds. A holding result holds the arguments. A mapped result holds callback results.
 * The receiver result is the receiver itself, or the first argument for Object.assign.
 */
export type LibraryResult = "fresh" | "shallow" | "element" | "holding" | "mapped" | "receiver";

export type LibraryStorage = "none" | "arguments" | "sources" | "splice" | "entry";

/**
 * A standard library call this analysis models.
 * An effect call reads or writes ambient state, which the identifier that names it reports.
 * A mutating call writes its receiver, or its first argument for Object.assign.
 * Callbacks are the argument indexes the call invokes before it returns.
 */
export type LibraryCall =
  | { readonly kind: "effect" }
  | { readonly kind: "pure" | "mutating"; readonly result: LibraryResult; readonly target: "receiver" | "argument"; readonly callbacks: readonly number[]; readonly stores: LibraryStorage };

export type AmbientFlow = readonly ["input" | "output", string];

export type LibraryCallback = { readonly kind: "pure" } | { readonly kind: "effect"; readonly flow: AmbientFlow };

const HOST_OBJECTS = new Set([
  "document", "globalThis", "localStorage", "location", "navigator", "process", "self", "sessionStorage", "window",
]);

const OUTPUT_SINKS = new Set([
  "alert", "console", "fetch", "queueMicrotask", "requestAnimationFrame", "setInterval", "setTimeout",
]);

const NONDETERMINISTIC_CALLS = new Set([
  "Date.now", "Math.random", "crypto.getRandomValues", "crypto.randomUUID", "performance.now",
]);

const FRESH_GLOBAL_CALLS = new Set([
  "Array.isArray", "Boolean", "Number", "Number.isFinite", "Number.isInteger",
  "Number.isNaN", "Number.parseFloat", "Number.parseInt", "Object.keys", "String", "parseFloat", "parseInt",
  "Promise.resolve", "Promise.reject", "Promise.all", "Promise.allSettled", "Promise.race", "structuredClone", "Math.abs", "Math.ceil", "Math.floor", "Math.max", "Math.min", "Math.pow", "Math.round",
  "Math.sign", "Math.sqrt", "Math.trunc",
]);

const CALLBACK_GLOBAL_CALLS = new Set(["JSON.parse", "JSON.stringify"]);

const ITERATING_GLOBAL_CALLS = new Set([
  "Array.from", "Object.fromEntries", "Promise.all", "Promise.allSettled", "Promise.race",
]);

const STORING_METHODS = new Map<string, LibraryStorage>([
  ["add", "arguments"], ["fill", "arguments"], ["push", "arguments"], ["set", "entry"],
  ["splice", "splice"], ["unshift", "arguments"],
]);

const HOLDING_GLOBAL_CALLS = new Map<string, readonly number[]>([
  ["Array.from", [1]], ["Array.of", []], ["Object.entries", []], ["Object.fromEntries", []], ["Object.values", []],
]);

const PURE_METHODS = new Map<string, LibraryResult>([
  ...methods("fresh", [
    "charAt", "charCodeAt", "codePointAt", "endsWith", "every", "findIndex", "findLastIndex", "forEach", "getTime",
    "has", "includes", "indexOf", "join", "lastIndexOf", "localeCompare", "normalize", "padEnd", "padStart", "repeat",
    "replace", "replaceAll", "some", "split", "startsWith", "substring", "toFixed", "toLocaleLowerCase",
    "toLocaleUpperCase", "toLowerCase", "toString", "toUpperCase", "trim", "trimEnd", "trimStart",
  ]),
  ...methods("shallow", ["entries", "filter", "flat", "keys", "slice", "toReversed", "toSorted", "values"]),
  ...methods("element", ["at", "find", "findLast", "get"]),
  ...methods("holding", ["concat"]),
  ...methods("mapped", ["flatMap", "map", "reduce", "reduceRight"]),
]);

const MUTATING_METHODS = new Map<string, LibraryResult>([
  ...methods("receiver", [
    "add", "append", "appendChild", "clear", "copyWithin", "delete", "fill", "insertBefore", "prepend", "push",
    "remove", "removeAttribute", "removeChild", "removeItem", "replaceChildren", "reverse", "set", "setAttribute",
    "setItem", "sort", "unshift", "write", "writeln",
  ]),
  ...methods("element", ["pop", "shift"]),
  ...methods("shallow", ["splice"]),
]);

const CALLBACK_METHODS = new Set([
  "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flatMap", "forEach", "map", "reduce",
  "reduceRight", "some", "sort", "toSorted",
]);

const OPTIONAL_CALLBACK_CALLS = new Set(["JSON.parse", "JSON.stringify", "replace", "replaceAll"]);

const PURE_CONSTRUCTORS = new Set([
  "Array", "Date", "Error", "Map", "Object", "RangeError", "RegExp", "Set", "TypeError", "URL", "URLSearchParams",
  "WeakMap", "WeakSet",
]);


function methods(result: LibraryResult, names: readonly string[]): [string, LibraryResult][] {
  return names.map((name) => [name, result]);
}

/** Tells if the name is a standard constructor that builds fresh storage. */
export function isPureConstructor(name: string | undefined): boolean {
  return name !== undefined && PURE_CONSTRUCTORS.has(name);
}

export function libraryCallback(expression: ts.Expression, model: ScopeModel): LibraryCallback | undefined {
  const name = globalName(expression, model);
  if (!name) {
    return undefined;
  }
  if (NONDETERMINISTIC_CALLS.has(name)) {
    return { kind: "effect", flow: ["input", `calls ${name}`] };
  }
  if (name.startsWith("console.") || OUTPUT_SINKS.has(name)) {
    return { kind: "effect", flow: ["output", `uses ${name.startsWith("console.") ? "console" : name}`] };
  }
  return FRESH_GLOBAL_CALLS.has(name) ? { kind: "pure" } : undefined;
}

/** Tells if the method name is one this analysis models for standard library receivers. */
export function isLibraryMethodName(name: string): boolean {
  return PURE_METHODS.has(name) || MUTATING_METHODS.has(name);
}

/** Classifies a known standard call or a conservative receiver write. */
export function libraryCall(call: ts.CallExpression, model: ScopeModel): LibraryCall | undefined {
  const callee = unwrapExpression(call.expression);
  const name = globalName(callee, model);
  if (name !== undefined) {
    const known = globalCall(name, callee);
    if (known) {
      return optionalCallbacks(call, model, name, known);
    }
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return undefined;
  }
  const method = methodName(callee);
  const known = memberCall(method);
  if (known?.kind === "pure" && !standardMethod(model, callee.expression, method)) {
    return undefined;
  }
  return known ? optionalCallbacks(call, model, method, known) : undefined;
}

function optionalCallbacks(call: ts.CallExpression, model: ScopeModel, name: string | undefined, known: LibraryCall): LibraryCall {
  if (known.kind === "effect" || !OPTIONAL_CALLBACK_CALLS.has(name ?? "")) {
    return known;
  }
  const callbacks = known.callbacks.filter((index) => {
    const argument = call.arguments[index];
    return argument && !nonCallableArgument(argument, model);
  });
  return { ...known, callbacks };
}

function nonCallableArgument(argument: ts.Expression, model: ScopeModel): boolean {
  const value = unwrapExpression(argument);
  return [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.VoidExpression, ts.SyntaxKind.ObjectLiteralExpression].includes(value.kind) ||
    globalName(value, model) === "undefined" || standardMethod(model, value, "toString");
}

function globalCall(name: string, callee: ts.Expression): LibraryCall | undefined {
  const roots = [name.split(".")[0], globalObjectMember(callee) ?? ""];
  if (roots.some((root) => OUTPUT_SINKS.has(root)) || NONDETERMINISTIC_CALLS.has(name) || name === "Date") {
    return { kind: "effect" };
  }
  if (name === "Object.assign") {
    return { kind: "mutating", result: "receiver", target: "argument", callbacks: [], stores: "sources" };
  }
  if (CALLBACK_GLOBAL_CALLS.has(name)) {
    return { kind: "pure", result: "fresh", target: "argument", callbacks: [1], stores: "none" };
  }
  if (FRESH_GLOBAL_CALLS.has(name)) {
    return { kind: "pure", result: "fresh", target: "receiver", callbacks: [], stores: "none" };
  }
  const callbacks = HOLDING_GLOBAL_CALLS.get(name);
  return callbacks ? { kind: "pure", result: "holding", target: "argument", callbacks, stores: "none" } : undefined;
}

function memberCall(name: string | undefined): LibraryCall | undefined {
  if (name === undefined) {
    return undefined;
  }
  const callbacks = name === "replace" || name === "replaceAll" ? [1] : CALLBACK_METHODS.has(name) ? [0] : [];
  const mutating = MUTATING_METHODS.get(name);
  if (mutating) {
    return { kind: "mutating", result: mutating, target: "receiver", callbacks, stores: STORING_METHODS.get(name) ?? "none" };
  }
  const pure = PURE_METHODS.get(name);
  return pure ? { kind: "pure", result: pure, target: "receiver", callbacks, stores: "none" } : undefined;
}

export function iteratedArgument(call: ts.CallExpression, model: ScopeModel): ts.Expression | undefined {
  return ITERATING_GLOBAL_CALLS.has(globalName(call.expression, model) ?? "") ? call.arguments[0] : undefined;
}

function dateCallDescription(expression: ts.Expression): string | undefined {
  const parent = expression.parent;
  if ((!ts.isNewExpression(parent) && !ts.isCallExpression(parent)) || parent.expression !== expression) {
    return undefined;
  }
  if (ts.isNewExpression(parent) && (parent.arguments?.length ?? 0) !== 0) {
    return undefined;
  }
  return `calls ${ts.isNewExpression(parent) ? "new " : ""}Date()`;
}

function ambientMethodCallName(expression: ts.Expression): string | undefined {
  const access = outerExpression(expression).parent;
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) {
    return undefined;
  }
  const callee = outerExpression(access);
  const call = callee.parent;
  if (!ts.isCallExpression(call) || call.expression !== callee) {
    return undefined;
  }
  const method = methodName(access);
  const receiver = unwrapExpression(access.expression);
  if (!method || !ts.isIdentifier(receiver)) {
    return undefined;
  }
  return `${receiver.text}.${method}`;
}

function ambientCallDescription(node: ts.Identifier): string | undefined {
  const expression = outerExpression(node);
  if (node.text === "Date") {
    const dateCall = dateCallDescription(expression);
    if (dateCall) {
      return dateCall;
    }
  }
  const name = ambientMethodCallName(expression);
  return name && NONDETERMINISTIC_CALLS.has(name) ? `calls ${name}()` : undefined;
}

function sinkName(node: ts.Identifier): string {
  const expression = outerExpression(node);
  const parent = expression.parent;
  const access = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === expression
    ? parent
    : undefined;
  return (access && globalObjectMember(access)) ?? node.text;
}

/** Gives the ambient input or output that an unbound identifier reaches. */
export function ambientFlow(node: ts.Identifier, written: boolean): AmbientFlow | undefined {
  const sink = sinkName(node);
  if (OUTPUT_SINKS.has(sink)) {
    return ["output", `uses ${sink}`];
  }
  if (HOST_OBJECTS.has(node.text)) {
    return written ? ["output", `writes ${node.text}`] : ["input", `reads ${node.text}`];
  }
  const call = ambientCallDescription(node);
  return call ? ["input", call] : undefined;
}
