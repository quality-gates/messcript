# Reports

messcript always builds one internal list of findings and one list of processing
errors, then renders both into the format you asked for. Integrations should
parse a structured format. Do not scrape `text` output.

## Shared rules every consumer can rely on

- Findings are sorted by path and line, then rule name, message, context, and
  priority. Processing errors are sorted by path, line, and message.
- `ansi`, `github`, and `gitlab` emit ordered findings first, then ordered
  processing errors. `text` interleaves both streams by location. `html` groups
  findings under a heading per path, then lists processing errors.
- Paths in human and GitHub/GitLab output are normalized to `/` and made relative
  to the working directory when possible.
- Lines and columns are 1-based.
- Suppressed findings appear only when you pass `--strict`.
- JSON, XML, and SARIF keep findings and processing errors in separate
  collections. Single-stream formats label processing errors as
  `ProcessingError`.
- Consumers must tolerate additional fields in future compatible releases.

## Canonical finding fields

Every structured finding carries these fields.

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Source path. |
| `line`, `column` | integer | Source location. |
| `ruleName` | string | Stable rule identity. |
| `priority` | integer | 1 highest through 5 lowest. |
| `message` | string | Human-readable explanation. |
| `context` | string | Class, callable, member, or name context. |
| `suppressed` | boolean | Whether an in-source directive suppressed the finding. |

Processing errors carry `path`, `line`, `column`, and `message`. Formats that
need a rule identity for errors use `ProcessingError` and priority `1`.

Tool metadata is always `{ "name": "messcript", "version": VERSION }`, using the
same version source as package metadata and `messcript --version`.

## Priority mappings

When a host format needs a severity label, messcript maps priority like this:

| Priority | GitLab severity |
|---:|---|
| 1 | `blocker` |
| 2 | `critical` |
| 3 | `major` |
| 4 | `minor` |
| 5 | `info` |

Checkstyle uses severity `warning` for findings and `error` for processing
errors. SARIF uses level `warning` for findings; processing errors appear as
execution notifications with level `error`.

## Which format for which job

| Goal | Format |
|---|---|
| Read findings locally | `text` or `ansi` |
| Store a complete machine report | `json` or `xml` |
| Browse a simple HTML table | `html` |
| Annotate GitHub Actions logs / PRs | `github` |
| Feed GitLab Code Quality | `gitlab` |
| Feed a Checkstyle-compatible step | `checkstyle` |
| Upload to code scanning | `sarif` |

## Formats

### JSON

Best default for custom scripts and archives.

```json
{
  "tool": { "name": "messcript", "version": "VERSION" },
  "findings": [
    {
      "path": "...",
      "line": 1,
      "column": 1,
      "ruleName": "...",
      "priority": 3,
      "message": "...",
      "context": "...",
      "suppressed": false
    }
  ],
  "errors": [
    { "path": "...", "line": 1, "column": 1, "message": "..." }
  ]
}
```

### XML

Same information as JSON, attribute-oriented.

Root `<messcript version="VERSION">` contains
`<tool name="messcript" version="VERSION" />`, then `<findings>` of empty
`<finding .../>` elements and `<errors>` of empty `<error .../>` elements.
Attributes are the canonical fields, XML-escaped.

### text / ANSI

Human output:

```text
path:line:column: RuleName [priority N] [suppressed] message (context: CONTEXT)
path:line:column: ProcessingError message
```

ANSI adds terminal color escapes only. The text content is otherwise identical.
The `[suppressed]` marker appears only for suppressed findings in `--strict`
runs. For `text`, `--color=always` styles output; `auto` styles only when stdout
is a TTY. `ansi` always styles finding names and messages.

### HTML

One findings table per source path (heading = path) with Line, Column, Rule,
Priority, Message, Context, and State (`suppressed` or empty). A separate
processing-error table follows when needed. All text cells are HTML-escaped.

### GitHub

One workflow command per record so Actions can attach annotations to source
lines:

- finding: `::warning file=PATH,line=LINE,col=COLUMN,title=RuleName [priority N]::MESSAGE (context: CONTEXT) [suppressed]`
  The trailing ` [suppressed]` segment is present only when suppressed.
- error: `::error file=PATH,line=LINE,col=COLUMN,title=ProcessingError::MESSAGE`

`%`, CR, LF, `:`, and `,` in path, title, and message values are percent-escaped.

### GitLab Code Quality

A JSON array ready for `artifacts: reports: codequality`:

```json
{
  "type": "issue",
  "check_name": "RuleName",
  "description": "MESSAGE (context: CONTEXT) [suppressed]",
  "fingerprint": "HEX",
  "severity": "major",
  "location": { "path": "PATH", "lines": { "begin": 1 } },
  "priority": 3,
  "suppressed": false
}
```

`fingerprint` is the hex encoding of UTF-8 `path:line:column:ruleName:message`.
Severity uses the priority table above. The description omits the trailing
` [suppressed]` segment when the finding is not suppressed. Processing errors
use `check_name=ProcessingError`.

### Checkstyle

Useful when an existing pipeline already knows Checkstyle XML:

```xml
<checkstyle tool="messcript" version="VERSION">
  <file name="PATH">
    <error line="1" column="1" severity="warning" message="..." source="messcript.RuleName" context="..." priority="3" suppressed="false" />
  </file>
</checkstyle>
```

Files are sorted by path. `source` is `messcript.` plus `ruleName`. Findings use
severity `warning`; processing errors use `error` and
`source="messcript.ProcessingError"`.

### SARIF 2.1.0

Use this for GitHub code scanning and other SARIF hosts:

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": {
      "driver": {
        "name": "messcript",
        "version": "VERSION",
        "rules": [{ "id": "RuleName", "shortDescription": { "text": "RuleName" } }]
      }
    },
    "results": [{
      "ruleId": "RuleName",
      "level": "warning",
      "message": { "text": "MESSAGE" },
      "locations": [{
        "physicalLocation": {
          "artifactLocation": { "uri": "PATH" },
          "region": { "startLine": 1, "startColumn": 1 }
        }
      }],
      "properties": { "priority": 3, "context": "CONTEXT", "suppressed": false },
      "suppressions": [{ "kind": "inSource" }]
    }],
    "invocations": [{
      "executionSuccessful": true,
      "toolExecutionNotifications": [{
        "level": "error",
        "message": { "text": "PATH:LINE:COLUMN: MESSAGE" },
        "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "PATH" }, "region": { "startLine": 1, "startColumn": 1 } } }]
      }]
    }]
  }]
}
```

`suppressions` is present only for suppressed findings.
`toolExecutionNotifications` is present only when processing errors exist; then
`executionSuccessful` is `false`.
