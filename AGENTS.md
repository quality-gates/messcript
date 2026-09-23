When reporting information to the user, be extremely concise. Sacrifice grammar for the sake of concision, clarity, and informality. 

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain-doc layout. See `docs/agents/domain.md`.

### Resource-safe mutation iteration

Fleet runs many repositories concurrently on an 8-core macOS host. During iteration, invoke Stryker directly with `--concurrency 1` and mutate only changed production files or changed line ranges:

```console
./node_modules/.bin/stryker run --concurrency 1 --mutate "src/file.ts:START-END"
```

Use the changed-file and line-range behavior in `scripts/changed-production-files.mjs`. Use the whole changed file for a new production file. Run the covered-MSI score command separately when you need a score. Use the direct Stryker command rather than appending mutation options to `npm run mutation -- ...`: the npm script contains `stryker run && node scripts/covered-msi.mjs ...`, so appended arguments reach the score command after `&&`.
