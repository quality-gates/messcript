export function isCamelCaseName(name: string, allowUnderscore = false): boolean {
  if (name === "_") {
    return true;
  }
  const normalized = name.replace(/^#/, "");
  if (allowUnderscore && normalized.startsWith("_")) {
    return normalized.length === 1 || isCamelCaseName(normalized.slice(1));
  }
  return normalized === "$" || /^\$?[a-z][A-Za-z0-9]*$/.test(normalized);
}

export function isPascalCaseName(name: string): boolean {
  const normalized = name.replace(/^#/, "");
  return /^[A-Z][A-Za-z0-9]*$/.test(normalized);
}
