// messcript-disable ConstantNamingConventions
import { basename, sep } from "node:path";

const testDirectoryNames = new Set(["__spec__", "__specs__", "__test__", "__tests__", "spec", "specs", "test", "tests"]);

/**
 * Whether a source path looks like a test file: it lives under a conventional
 * test directory (e.g. `test/`, `__tests__/`) or its own name marks it as a
 * test/spec file (e.g. `foo.test.ts`, `foo.spec.tsx`).
 */
export function isTestContextFileName(path: string): boolean {
  const parts = path.split(sep);
  return parts.slice(0, -1).some((part) => testDirectoryNames.has(part.toLowerCase())) || /\.(?:test|spec)\.[^.]+$/i.test(basename(path));
}
