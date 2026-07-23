import ts from "typescript";
import type { Finding } from "./finding";

type DirectiveKind = "disable-next-line" | "disable" | "enable";

type Directive = {
  line: number;
  kind: DirectiveKind;
  rules: readonly string[];
};

function commentText(token: string): string {
  if (token.startsWith("//")) {
    return token.slice(2).trim();
  }
  return token.slice(2, -2).trim();
}

function parseDirective(token: string, line: number): Directive | undefined {
  const match = /^messcript-(disable-next-line|disable|enable)\b([\s\S]*)$/i.exec(commentText(token));
  if (!match) {
    return undefined;
  }
  const rules = match[2]
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((rule) => rule.toLowerCase());
  if (rules.length === 0 || rules.some((rule) => !/^[a-z][a-z0-9]*$/.test(rule))) {
    return undefined;
  }
  return { line, kind: match[1].toLowerCase() as DirectiveKind, rules };
}

// messcript-disable-next-line CyclomaticComplexity
function directivesIn(sourceFile: ts.SourceFile): readonly Directive[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.JSX,
    sourceFile.getFullText(),
  );
  const directives: Directive[] = [];
  const templateExpressionDepths: number[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const position = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos());
      const directive = parseDirective(scanner.getTokenText(), position.line + 1);
      if (directive) {
        directives.push(directive);
      }
    }

    if (token === ts.SyntaxKind.TemplateHead) {
      templateExpressionDepths.push(1);
    } else if (templateExpressionDepths.length > 0) {
      const depth = templateExpressionDepths.length - 1;
      if (token === ts.SyntaxKind.OpenBraceToken) {
        templateExpressionDepths[depth] += 1;
      } else if (token === ts.SyntaxKind.CloseBraceToken) {
        templateExpressionDepths[depth] -= 1;
        if (templateExpressionDepths[depth] === 0) {
          templateExpressionDepths.pop();
          token = scanner.reScanTemplateToken(false);
          if (token === ts.SyntaxKind.TemplateMiddle) {
            templateExpressionDepths.push(1);
          }
        }
      }
    }
    token = scanner.scan();
  }
  return directives;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function suppressedRulesByLine(sourceFile: ts.SourceFile): ReadonlyMap<number, ReadonlySet<string>> {
  const disables = new Map<number, Directive[]>();
  for (const directive of directivesIn(sourceFile)) {
    const entries = disables.get(directive.line) ?? [];
    entries.push(directive);
    disables.set(directive.line, entries);
  }

  const active = new Map<string, number>();
  const nextLine = new Map<number, Set<string>>();
  const result = new Map<number, ReadonlySet<string>>();
  const lineCount = sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1;

  for (let line = 1; line <= lineCount; line += 1) {
    // messcript-disable-next-line UnusedLocalVariable
    for (const directive of disables.get(line) ?? []) {
      if (directive.kind === "enable") {
        for (const rule of directive.rules) {
          const count = active.get(rule) ?? 0;
          if (count <= 1) {
            active.delete(rule);
          } else {
            active.set(rule, count - 1);
          }
        }
      }
    }

    // messcript-disable-next-line UnusedLocalVariable
    const suppressed = new Set([...active.keys(), ...(nextLine.get(line) ?? [])]);
    result.set(line, suppressed);
    nextLine.delete(line);

    for (const directive of disables.get(line) ?? []) {
      if (directive.kind === "disable") {
        for (const rule of directive.rules) {
          active.set(rule, (active.get(rule) ?? 0) + 1);
        }
      } else if (directive.kind === "disable-next-line") {
        const rules = nextLine.get(line + 1) ?? new Set<string>();
        for (const rule of directive.rules) {
          rules.add(rule);
        }
        nextLine.set(line + 1, rules);
      }
    }
  }

  return result;
}

export function applySuppressions(
  sourceFile: ts.SourceFile,
  findings: readonly Finding[],
  strict: boolean,
): Finding[] {
  const suppressedByLine = suppressedRulesByLine(sourceFile);
  return findings.flatMap((finding) => {
    if (!suppressedByLine.get(finding.line)?.has(finding.ruleName.toLowerCase())) {
      return [finding];
    }
    return strict ? [{ ...finding, suppressed: true }] : [];
  });
}
