# Evidence — SARIF reports absolute filesystem paths

messcript 0.1.8, built from `34cfcdd`. Node v26.7.0.

Fixture checkout at `~/mx-real` containing `src/ovl.ts`; the command is run from
`~/mx-real`, so the file is under the working directory.

## SARIF

```console
$ node dist/cli.js src sarif typescript
```

```json
{
 "physicalLocation": {
  "artifactLocation": { "uri": "/Users/jonathanbaldie/mx-real/src/ovl.ts" },
  "region": { "startLine": 1, "startColumn": 1 }
 }
}
```

## Same run, `text` format

```console
$ node dist/cli.js src text typescript
src/ovl.ts:1:1: ShortMethodName ...
```

`github` and `gitlab` output are relative in the same way (`"path": "src/orders.ts"`).
No `uriBaseId` or `originalUriBaseIds` appears anywhere in the SARIF document.

Reproduced twice, and from a second working directory (`/tmp/mx/proj`), where the
uri was `/private/tmp/mx/proj/src/orders.ts`.
