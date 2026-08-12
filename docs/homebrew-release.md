# Homebrew release operations

Stable tags publish standalone native macOS archives to an immutable GitHub
release, then dispatch formula generation to `quality-gates/homebrew-tap`. The
GitHub release is the release commit point. A later tap failure does not roll it
back.

## One-time repository setup

1. Enable immutable releases for `quality-gates/messcript`. Protect `v*` tags so
   only release maintainers can create or update them.
2. Create an organization-owned GitHub App with only **Actions: write**. Install
   it only on `quality-gates/homebrew-tap`, and keep it off ruleset bypass lists.
3. Create a protected `release` environment in `messcript`. Require approval,
   and allow deployments from stable tags plus `main` for manual retries.
4. Create a protected `homebrew` environment in `messcript`. Add
   `HOMEBREW_TAP_APP_ID` and `HOMEBREW_TAP_APP_PRIVATE_KEY` as environment
   secrets. Require approval, and allow deployments from stable tags plus
   `main` for manual retries.
5. In `homebrew-tap`, allow Actions to create pull requests. Protect `main` and
   require the tap tests. Decide whether passing formula PRs auto-merge or wait
   for maintainer review. Automation does not push a formula directly to
   `main`.

## Normal release

Set `package.json` to the intended version, then push a tag that matches
`vMAJOR.MINOR.PATCH`. The tag version and package version must match. The
release workflow validates the remote tag, runs the complete test suite, and
builds standalone Intel and Apple Silicon executables. It packages each exact
executable with `LICENSE`, then tests the archives on matching macOS runners.

The published release contains only these assets:

- `messcript_VERSION_darwin_arm64.tar.gz`
- `messcript_VERSION_darwin_amd64.tar.gz`
- `checksums.txt`

After GitHub marks the release immutable, the workflow uses the protected
`homebrew` environment to dispatch `publish-formula.yml` on the tap's `main`
branch. The tap verifies the release ID, tag, source commit, exact asset set,
and archive hashes before opening or updating its formula PR.

## Recovery

Run the `Release` workflow manually with the existing stable `tag` to retry a
failed release or Homebrew stage.

- A matching draft keeps matching assets and uploads only missing assets.
- A draft with different bytes stops. Automation does not replace it.
- A matching immutable release skips rebuilding and retries tap publication.
- A published mutable or prerelease release stops tap publication.
- Duplicate tap dispatches converge on the same formula branch and PR.

If tap publication fails, keep the GitHub release and tag intact. Correct the
tap workflow, policy, credentials, or formula check, then retry the same tag.
