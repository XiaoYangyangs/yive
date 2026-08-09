# Contributing to Yive

Thanks for helping improve Yive. Please keep changes small, reviewable, and
aligned with the local-first multi-agent workflow.

## Before You File Something

- Bug reports: use the bug report issue template.
- Feature ideas: use the feature request issue template. For larger features,
  align on scope in an issue before opening a PR.
- Security reports: follow [SECURITY.md](./SECURITY.md). Do not open a public
  issue with exploit details, private logs, tokens, or workspace paths.

## Development Setup

```bash
pnpm install
pnpm dev
```

Development mode starts the runtime on `127.0.0.1:4010` and Vite on
`127.0.0.1:5180`.

Production-style local run:

```bash
pnpm build
node dist/src/cli/hive.js --port 4010
```

## Checks Before A PR

Run the focused checks that match your change. For broad changes, run the full
set:

```bash
pnpm check
pnpm build
pnpm test
```

The full test suite can be slower on Windows. If you intentionally run a
focused subset, list the exact command in the PR.

## PR Style

- Keep commits focused.
- Use imperative commit subjects, for example `fix mobile terminal resize`.
- Include the reason for the change, not just what changed.
- Include testing notes.
- Avoid unrelated refactors in feature or bug-fix PRs.

## Test Discipline

- Integration tests under `tests/server/*` and `tests/cli/*` should exercise
  real runtime behavior where practical.
- Pure logic tests belong under `tests/unit/`.
- Web UI tests belong under `tests/web/`.
- Assertions should fail when production code is implemented incorrectly.
  Avoid tautologies and tests that only assert on self-fed mocks.

## Code Style

- TypeScript is preferred throughout the codebase.
- Let Biome handle formatting through `pnpm check` and `pnpm format`.
- Prefer existing local patterns over new abstractions.
- Add comments only when the reason is not obvious from the code.

## License

By contributing, you agree that your contributions are licensed under the
project's current license, currently Business Source License 1.1. See
[LICENSE.BSL](./LICENSE.BSL).
