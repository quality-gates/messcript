export function isCamelCaseName(name: string): boolean {
  if (name === "_") {
    return true;
  }
  const normalized = name.replace(/^#/, "");
  return normalized === "$" || /^\$?[a-z][A-Za-z0-9]*$/.test(normalized);
}

export function isPascalCaseName(name: string): boolean {
  const normalized = name.replace(/^#/, "");
  return /^[A-Z][A-Za-z0-9]*$/.test(normalized);
}
