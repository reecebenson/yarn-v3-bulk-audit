# yarn-v3-bulk-audit

A Yarn plugin that backports Yarn 4's bulk-advisory implementation of `yarn npm audit` to Yarn `>=3.2.0 <4`.

The plugin replaces Yarn 3's legacy `/-/npm/v1/security/audits/quick` request with the `/-/npm/v1/security/advisories/bulk` endpoint and keeps the Yarn 4 command behavior: direct dependencies by default, `--recursive`, `--all`, production/development filtering, severity filtering, deprecation reports, package exclusions, advisory ignores, pretty output, and NDJSON output.

Internally, the bundle uses Yarn's plugin-name override mechanism to replace `@yarnpkg/plugin-npm-cli`. It loads the running Yarn release's original plugin and swaps only the audit command, so commands such as `npm publish`, `npm login`, and `npm info` retain the exact implementation shipped with that Yarn release.

## Install

Use Yarn's `plugin import` command (not `yarn run import`):

```sh
yarn plugin import https://raw.githubusercontent.com/reecebenson/yarn-v3-bulk-audit/refs/heads/main/plugin-yarn-bulkaudit.js
```

A local build can be imported with:

```sh
yarn plugin import ./plugin-yarn-bulkaudit.js
```

Then use the normal command:

```sh
yarn npm audit --recursive
```

The committed root bundle is the distributable file. Importing it adds a checksum-pinned entry to the consuming project's `.yarnrc.yml` and copies the plugin into `.yarn/plugins`.

## Command compatibility

The command matches Yarn 4's options:

```text
-A, --all
-R, --recursive
--environment all|production|development
--json
--no-deprecations
--severity info|low|moderate|high|critical
--exclude <glob> (repeatable)
--ignore <advisory-id-glob> (repeatable)
```

Persistent exclusions and ignores can be placed in `.yarnrc.yml`:

```yaml
npmAuditExcludePackages:
  - "@internal/*"

npmAuditIgnoreAdvisories:
  - "GHSA-example-*"
```

The audit registry continues to use Yarn 3's existing `npmAuditRegistry` setting. Package deprecation metadata is deliberately fetched from the package's normal scope registry, matching Yarn 4 behavior.

## Development

Requires Node 18 or newer:

```sh
npm ci
npm run check
```

`npm run check` typechecks against Yarn 3.2.0, builds the distributable with Yarn's plugin builder, and imports it into temporary projects running Yarn 3.2.0 and the last Yarn 3 release (3.8.7). This also verifies that this plugin wins over Yarn 3's built-in `npm audit` command.

The old Yarn packages use broad, independently-versioned peer ranges that modern npm cannot resolve consistently. `.npmrc` enables legacy peer resolution while the lockfile pins the tested dependency graph.

## Upstream synchronization

Run:

```sh
npm run sync:upstream
npm run check
```

The updater resolves Yarn's `master` branch to an immutable commit, verifies that `@yarnpkg/plugin-npm-cli` is still on major version 4, downloads the three source files that make up the audit implementation, and applies explicit Yarn 3 compatibility transforms. It fails loudly if an upstream edit invalidates any transform, so an incompatible source change cannot silently produce a broken bundle. `.yarn-audit-upstream.json` records the exact source commit.

The weekly `sync-upstream.yml` workflow performs the update, validation, and bundle regeneration, then opens or refreshes `automation/sync-yarn-audit`. It is deterministic and doesn't require an AI agent. In repository settings, GitHub Actions must be allowed to create and approve pull requests for the provided `GITHUB_TOKEN` flow to open the PR.

## Attribution

The audit command, types, and utilities are adapted from Yarn's `@yarnpkg/plugin-npm-cli`, licensed under BSD-2-Clause. Yarn 3 compatibility code and automation live in this repository under the same license.
