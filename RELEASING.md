# Releasing Minty

This is the recipe for cutting a Minty release. Maintainer-only operation, but documented here so contributors know the cadence and can predict when their merged PR will ship.

## Versioning policy

We follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the standard pre-1.0 caveat: while we're on `0.x`, **minor bumps may include breaking changes** when those changes are necessary to keep the project healthy. Breakages are always called out in `CHANGELOG.md` under a `### Breaking` heading.

Once we hit `1.0.0`, the usual SemVer contract applies — major for breakage, minor for additive, patch for fixes.

## Cadence

No fixed cadence. Releases happen when there's a meaningful chunk of `Unreleased` in [`CHANGELOG.md`](./CHANGELOG.md) — typically every 2-6 weeks. If you've merged a PR and want to know when it ships, check the `Unreleased` section.

## Cutting a release (maintainer)

The release is gated by [`.github/workflows/release.yml`](./.github/workflows/release.yml) — it runs the test matrix on Node 20/22 across Linux/macOS/Windows, then publishes the GitHub release using the `CHANGELOG.md` entry as the release notes.

Step by step:

1. **Decide the version.** Look at `Unreleased` in CHANGELOG. Pick `MAJOR.MINOR.PATCH` per the policy above.

2. **Update `CHANGELOG.md`.** Replace `## [Unreleased]` with `## [X.Y.Z] - YYYY-MM-DD` and start a new empty `## [Unreleased]` block above it. Ensure the entry has the standard [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections (`Added`, `Changed`, `Fixed`, `Removed`, `Breaking`, `Security`) where relevant.

3. **Bump `package.json`.**
   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```
   `--no-git-tag-version` keeps the tag step explicit.

4. **Commit.**
   ```bash
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "release: vX.Y.Z"
   ```

5. **Tag and push.**
   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

6. **Wait for the release workflow.** It verifies the tag matches `package.json`, extracts release notes from `CHANGELOG.md`, and creates the GitHub release. If it fails on `tag mismatch`, you forgot step 3.

## Hotfix

If `0.X.Y` has a security or production-breaking issue:

1. Branch from the tag: `git checkout -b hotfix/X.Y.Z+1 vX.Y.Z`
2. Land the fix.
3. Follow the cutting steps above with `Z+1`.
4. Rebase / cherry-pick into `main` if the issue isn't already fixed there.

## What goes in the release notes

The release workflow's `awk` extractor reads everything between `## [X.Y.Z]` and the next `## [`. So whatever you put in the CHANGELOG entry is exactly what users see. Treat it as the release notes — no separate prose required.
