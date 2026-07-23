import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import {
  canonicalPropertyName,
  componentRulesets,
  getRuleDefinition,
  type RuleProperties,
  type RuleSelection,
} from "./rules/catalog";

type XmlNode = {
  name: string;
  attributes: Map<string, string>;
  children: XmlNode[];
  text: string;
};

type SelectionMeta = {
  priority?: number;
  properties: RuleProperties;
};

export type LoadedRulesets = {
  selections: RuleSelection[];
  warnings: string[];
};

export type RuleFilterOptions = {
  minimumPriority?: number;
  maximumPriority?: number;
  only?: readonly string[];
  enable?: readonly string[];
  disable?: readonly string[];
};

export class RulesetError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(errors.join("\n"));
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseTag(raw: string): { closing: boolean; selfClosing: boolean; name: string; attributes: Map<string, string> } {
  let value = raw.trim();
  const closing = value.startsWith("/");
  if (closing) {
    value = value.slice(1).trim();
  }
  const selfClosing = !closing && value.endsWith("/");
  if (selfClosing) {
    value = value.slice(0, -1).trim();
  }
  const nameMatch = /^([^\s/>]+)/.exec(value);
  if (!nameMatch) {
    throw new Error("XML tag has no name");
  }
  const name = nameMatch[1].toLowerCase();
  const attributes = new Map<string, string>();
  const attributeSource = value.slice(nameMatch[0].length);
  const attributePattern = /([^\s=/>]+)\s*=\s*("[\s\S]*?"|'[\s\S]*?')/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(attributeSource))) {
    attributes.set(match[1].toLowerCase(), decodeXml(match[2].slice(1, -1)));
  }
  return { closing, selfClosing, name, attributes };
}

function parseXml(source: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let cursor = 0;

  function appendText(text: string): void {
    if (stack.length > 0) {
      stack[stack.length - 1].text += decodeXml(text);
    } else if (text.trim().length > 0) {
      throw new Error("XML has text outside its root element");
    }
  }

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) {
      appendText(source.slice(cursor));
      break;
    }
    appendText(source.slice(cursor, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end === -1) {
        throw new Error("XML comment is not closed");
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end === -1) {
        throw new Error("XML CDATA section is not closed");
      }
      appendText(source.slice(open + 9, end));
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = tagEnd(source, open + 2);
      if (end === -1) {
        throw new Error("XML declaration is not closed");
      }
      cursor = end + 1;
      continue;
    }
    if (source.startsWith("<!", open)) {
      const end = tagEnd(source, open + 2);
      if (end === -1) {
        throw new Error("XML declaration is not closed");
      }
      cursor = end + 1;
      continue;
    }

    const end = tagEnd(source, open + 1);
    if (end === -1) {
      throw new Error("XML tag is not closed");
    }
    const tag = parseTag(source.slice(open + 1, end));
    if (tag.closing) {
      const current = stack.pop();
      if (!current || current.name !== tag.name) {
        throw new Error(`XML closing tag does not match: ${tag.name}`);
      }
      cursor = end + 1;
      continue;
    }

    const node: XmlNode = { name: tag.name, attributes: tag.attributes, children: [], text: "" };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else if (root) {
      throw new Error("XML has more than one root element");
    } else {
      root = node;
    }
    if (!tag.selfClosing) {
      stack.push(node);
    }
    cursor = end + 1;
  }

  if (stack.length > 0) {
    throw new Error(`XML element is not closed: ${stack[stack.length - 1].name}`);
  }
  if (!root) {
    throw new Error("XML has no root element");
  }
  return root;
}

function directChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function attributeOrChild(node: XmlNode, name: string): string | undefined {
  const attribute = node.attributes.get(name.toLowerCase());
  if (attribute !== undefined) {
    return attribute;
  }
  const child = node.children.find((candidate) => candidate.name === name.toLowerCase());
  return child?.text.trim();
}

function directExclusions(node: XmlNode): Set<string> {
  return new Set(
    directChildren(node, "exclude")
      .map((child) => attributeOrChild(child, "name"))
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );
}

function propertiesFrom(node: XmlNode): RuleProperties {
  const properties: Record<string, string> = {};
  const containers = directChildren(node, "properties");
  const propertyNodes = [
    ...directChildren(node, "property"),
    ...containers.flatMap((container) => directChildren(container, "property")),
  ];
  for (const property of propertyNodes) {
    const name = attributeOrChild(property, "name");
    const value = attributeOrChild(property, "value");
    if (name !== undefined && value !== undefined) {
      properties[name.toLowerCase()] = value;
    }
  }
  return properties;
}

function priorityFrom(node: XmlNode, path: string): number | undefined {
  const value = attributeOrChild(node, "priority");
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new RulesetError([`Priority in '${path}' must be an integer between 1 and 5.`]);
  }
  return priority;
}

function mergeMeta(parent: SelectionMeta, node: XmlNode, path: string): SelectionMeta {
  return {
    priority: priorityFrom(node, path) ?? parent.priority,
    properties: { ...parent.properties, ...propertiesFrom(node) },
  };
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function resolveCaseInsensitivePath(value: string): string | undefined {
  const requested = resolve(value);
  if (existsSync(requested)) {
    return requested;
  }
  const root = parse(requested).root;
  const parts = requested.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = readdirSync(current).sort((left, right) => left.localeCompare(right));
    } catch {
      return undefined;
    }
    const match = entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
    if (!match) {
      return undefined;
    }
    current = join(current, match);
  }
  return current;
}

function componentName(value: string): string | undefined {
  const normalized = normalizedPath(value).replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 1 && componentRulesets[parts[0].toLowerCase()]) {
    return parts[0].toLowerCase();
  }
  if (parts.length >= 2 && parts.at(-2)?.toLowerCase() === "rulesets" && parts.at(-1)?.toLowerCase().endsWith(".xml")) {
    const name = parts.at(-1)?.slice(0, -4).toLowerCase();
    return name && componentRulesets[name] ? name : undefined;
  }
  if (parts.length === 1 && parts[0].toLowerCase().endsWith(".xml")) {
    const name = parts[0].slice(0, -4).toLowerCase();
    return componentRulesets[name] ? name : undefined;
  }
  return undefined;
}

function referencedRule(value: string): { component?: string; rule?: string; complete: boolean } {
  const normalized = normalizedPath(value);
  const parts = normalized.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  const lastLower = last.toLowerCase();
  if (lastLower.endsWith(".xml")) {
    return { component: componentName(normalized), complete: true };
  }
  if (parts.length >= 2) {
    const candidate = parts.at(-2) ?? "";
    const component = componentName(candidate);
    if (component) {
      return { component, rule: last, complete: false };
    }
  }
  return { rule: last || normalized, complete: false };
}

function canonicalProperties(ruleName: string, properties: RuleProperties): RuleProperties {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    result[canonicalPropertyName(ruleName, name)] = value;
  }
  return result;
}

function selection(ruleName: string, rulesetName: string, meta: SelectionMeta): RuleSelection | undefined {
  const definition = getRuleDefinition(ruleName);
  if (!definition) {
    return undefined;
  }
  return {
    name: definition.name,
    rulesetName,
    priority: meta.priority,
    properties: canonicalProperties(definition.name, meta.properties),
  };
}

type ExpansionState = {
  path: string;
  rulesetName: string;
  warnings: string[];
  errors: string[];
  selections: RuleSelection[];
  stack: Set<string>;
};

function warn(state: ExpansionState, message: string): void {
  state.warnings.push(message);
}

function addRule(state: ExpansionState, ruleName: string, meta: SelectionMeta, exclusions: ReadonlySet<string>): void {
  const definition = getRuleDefinition(ruleName);
  if (!definition) {
    state.errors.push(`Unknown rule '${ruleName}' in '${state.path}'.`);
    return;
  }
  if (exclusions.has(definition.name.toLowerCase())) {
    return;
  }
  const value = selection(definition.name, state.rulesetName, meta);
  if (value) {
    state.selections.push(value);
  }
}

function expandBuiltIn(
  state: ExpansionState,
  name: string,
  meta: SelectionMeta,
  exclusions: ReadonlySet<string>,
): void {
  for (const ruleName of componentRulesets[name] ?? []) {
    addRule(state, ruleName, meta, exclusions);
  }
}

function resolveCustomReference(state: ExpansionState, reference: string): string | undefined {
  return resolveCaseInsensitivePath(resolve(dirname(state.path), reference));
}

function expandReference(
  state: ExpansionState,
  reference: string,
  meta: SelectionMeta,
  exclusions: ReadonlySet<string>,
): void {
  const shortComponent = componentName(reference);
  if (shortComponent) {
    expandBuiltIn(state, shortComponent, meta, exclusions);
    return;
  }
  const parsed = referencedRule(reference);
  if (parsed.complete && parsed.component) {
    expandBuiltIn(state, parsed.component, meta, exclusions);
    return;
  }
  if (parsed.component && parsed.rule) {
    if (getRuleDefinition(parsed.rule)) {
      addRule(state, parsed.rule, meta, exclusions);
    } else {
      warn(state, `Unknown referenced rule '${parsed.rule}' in '${state.path}'.`);
    }
    return;
  }
  const directRule = parsed.rule ?? reference;
  if (!parsed.complete && !normalizedPath(reference).includes("/") && getRuleDefinition(directRule)) {
    addRule(state, directRule, meta, exclusions);
    return;
  }
  const custom = resolveCustomReference(state, reference);
  if (custom) {
    expandCustomFile(state, custom, meta, exclusions);
    return;
  }
  if (parsed.complete) {
    warn(state, `Unknown referenced ruleset '${reference}' in '${state.path}'.`);
  } else {
    warn(state, `Unknown referenced rule '${directRule}' in '${state.path}'.`);
  }
}

function expandRuleNode(state: ExpansionState, node: XmlNode, inherited: SelectionMeta, inheritedExclusions: ReadonlySet<string>): void {
  const exclusions = new Set([...inheritedExclusions, ...directExclusions(node)]);
  const meta = mergeMeta(inherited, node, state.path);
  const reference = attributeOrChild(node, "ref");
  const name = attributeOrChild(node, "name");
  if (reference !== undefined) {
    expandReference(state, reference, meta, exclusions);
    return;
  }
  if (name !== undefined) {
    addRule(state, name, meta, exclusions);
  }
}

function expandContainer(state: ExpansionState, node: XmlNode, inherited: SelectionMeta, inheritedExclusions: ReadonlySet<string>): void {
  const exclusions = new Set([...inheritedExclusions, ...directExclusions(node)]);
  const meta = mergeMeta(inherited, node, state.path);
  for (const child of node.children) {
    if (child.name === "rule") {
      expandRuleNode(state, child, meta, exclusions);
      continue;
    }
    if (child.name !== "ruleset") {
      continue;
    }
    const childMeta = mergeMeta(meta, child, state.path);
    const childExclusions = new Set([...exclusions, ...directExclusions(child)]);
    const reference = attributeOrChild(child, "ref");
    const name = attributeOrChild(child, "name");
    if (reference !== undefined) {
      expandReference(state, reference, childMeta, childExclusions);
    } else if (name !== undefined && componentRulesets[name.toLowerCase()]) {
      expandBuiltIn(state, name.toLowerCase(), childMeta, childExclusions);
    } else if (name !== undefined && child.children.some((candidate) => candidate.name === "rule" || candidate.name === "ruleset")) {
      expandContainer(state, child, childMeta, childExclusions);
    } else if (name !== undefined) {
      warn(state, `Unknown referenced ruleset '${name}' in '${state.path}'.`);
    } else {
      warn(state, `Could not understand ruleset reference in '${state.path}'.`);
    }
  }
}

function expandCustomFile(
  state: ExpansionState,
  path: string,
  inherited: SelectionMeta,
  inheritedExclusions: ReadonlySet<string>,
): void {
  const fullPath = resolve(path);
  if (state.stack.has(fullPath)) {
    warn(state, `Circular ruleset reference '${path}' in '${state.path}'.`);
    return;
  }
  state.stack.add(fullPath);
  let root: XmlNode;
  try {
    root = parseXml(readFileSync(fullPath, "utf8"));
  } catch (error) {
    state.errors.push(`Could not read custom ruleset '${fullPath}': ${error instanceof Error ? error.message : "Unknown error"}`);
    state.stack.delete(fullPath);
    return;
  }
  if (root.name !== "ruleset") {
    state.errors.push(`Custom ruleset '${fullPath}' must have a ruleset root element.`);
    state.stack.delete(fullPath);
    return;
  }
  const previousPath = state.path;
  state.path = fullPath;
  const rootName = attributeOrChild(root, "name") ?? basename(fullPath, extname(fullPath));
  const previousRulesetName = state.rulesetName;
  state.rulesetName = rootName;
  expandContainer(state, root, inherited, inheritedExclusions);
  state.rulesetName = previousRulesetName;
  state.path = previousPath;
  state.stack.delete(fullPath);
}

function loadOne(name: string): LoadedRulesets {
  const trimmed = name.trim();
  const customPath = resolveCaseInsensitivePath(trimmed);
  const state: ExpansionState = {
    path: customPath ?? resolve(trimmed),
    rulesetName: trimmed,
    warnings: [],
    errors: [],
    selections: [],
    stack: new Set(),
  };
  const builtIn = componentName(trimmed);
  if (builtIn) {
    expandBuiltIn(state, builtIn, { properties: {} }, new Set());
  } else if (customPath) {
    expandCustomFile(state, customPath, { properties: {} }, new Set());
  } else {
    state.errors.push(`Unknown ruleset '${trimmed}'.`);
  }
  if (state.errors.length > 0) {
    throw new RulesetError(state.errors);
  }
  return { selections: state.selections, warnings: state.warnings };
}

function mergeSelection(existing: RuleSelection, incoming: RuleSelection): RuleSelection {
  return {
    name: existing.name,
    rulesetName: incoming.rulesetName,
    priority: incoming.priority ?? existing.priority,
    properties: { ...existing.properties, ...incoming.properties },
  };
}

function deduplicate(selections: readonly RuleSelection[]): RuleSelection[] {
  const merged = new Map<string, RuleSelection>();
  for (const selection of selections) {
    const key = selection.name.toLowerCase();
    const existing = merged.get(key);
    merged.set(key, existing ? mergeSelection(existing, selection) : selection);
  }
  return [...merged.values()];
}

export function loadRulesets(names: readonly string[]): LoadedRulesets {
  const selections: RuleSelection[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const name of names) {
    try {
      const loaded = loadOne(name);
      selections.push(...loaded.selections);
      warnings.push(...loaded.warnings);
    } catch (error) {
      if (error instanceof RulesetError) {
        errors.push(...error.errors);
      } else {
        errors.push(error instanceof Error ? error.message : `Could not load ruleset '${name}'.`);
      }
    }
  }
  if (errors.length > 0) {
    throw new RulesetError(errors);
  }
  return { selections: deduplicate(selections), warnings };
}

export function applyRuleFilters(
  loaded: LoadedRulesets,
  options: RuleFilterOptions,
): LoadedRulesets {
  const requested = [...(options.only ?? []), ...(options.enable ?? [])].map((name) => name.trim().toLowerCase()).filter(Boolean);
  const disabled = (options.disable ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
  const loadedNames = new Set(loaded.selections.map((selection) => selection.name.toLowerCase()));
  const missingRequested = requested.find((name) => !loadedNames.has(name));
  if (missingRequested) {
    throw new RulesetError([`Requested rule '${missingRequested}' is not present in the loaded rulesets.`]);
  }
  const missingDisabled = disabled.find((name) => !loadedNames.has(name));
  if (missingDisabled) {
    throw new RulesetError([`Disabled rule '${missingDisabled}' is not present in the loaded rulesets.`]);
  }
  const requestedSet = new Set(requested);
  const selections = loaded.selections.filter((selection) => {
    const priority = selection.priority ?? getRuleDefinition(selection.name)?.priority ?? 3;
    return (
      (requestedSet.size === 0 || requestedSet.has(selection.name.toLowerCase())) &&
      !disabled.includes(selection.name.toLowerCase()) &&
      (options.minimumPriority === undefined || priority <= options.minimumPriority) &&
      (options.maximumPriority === undefined || priority >= options.maximumPriority)
    );
  });
  return { ...loaded, selections };
}
