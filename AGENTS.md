# AGENTS.md

Public coding rules for AI-assisted work in this repository.

Hive's unpublished implementation plans and product strategy are not published
here. For public contributions, use the current code, README, tests, and issue
discussion as the source of truth. If behavior is unclear, ask before changing
protocol semantics.

## Hard Bans

### No test-only production fallbacks

Do not add production branches just to make a test easier to run. Mock or isolate
test dependencies in tests; keep production code on the real runtime path.

### No broad exception swallowing

Do not catch errors and match strings to hide root causes. Fix the cause or use
typed errors / explicit error codes.

### No fake tests

Avoid tests that only prove a mock was called, `expect(true).toBe(true)`,
source-string assertions, or `not.toThrow()` without checking behavior. A test
must fail when the production behavior is wrong.

### No weak generated IDs

Use `crypto.randomUUID()` for IDs. Do not use `Math.random().toString(36)`.

### No memory-before-database writes

When state is persisted, write to SQLite first and update in-memory state only
after persistence succeeds, or wrap the full change in a transaction.

## Required Practices

### Preserve public protocol contracts

HTTP and JSON payloads use snake_case at the boundary. TypeScript internals may
use camelCase, but serialization must keep the public shape stable.

### Preserve the canonical Agent state model

Agent truth has independent dimensions: process state (`running`, `stopped`, or
`crashed`), Provider-verified conversation activity (`busy`, `idle`, or
`unknown`), active Dispatch identity, queued Dispatch count, nullable queue
pause reason, and last observation time. Do not restore an aggregate
`idle / working / stopped` Agent status or infer conversation activity from PTY
output, terminal silence, elapsed time, or Dispatch counts. Stale or
unverifiable Provider state is `unknown`; automation that requires an idle
boundary must fail closed.

### Preserve the flat agent identity model

Each workspace has exactly one Orchestrator and zero or more flat Workers.
Authorization derives from `orchestrator` or `worker` kind. A Worker's concrete
responsibility comes from its active Dispatch, so do not reintroduce persisted
specialist Roles, Role descriptions, Role instructions, or Role templates.

### Preserve the managed Provider boundary

Managed Agents use only the native Codex or Claude Code Provider adapters.
Do not add OpenCode, Gemini, arbitrary Agent startup commands, custom command
presets, Provider credentials, model settings, or generic Session-capture
configuration. Ordinary Workspace Shell terminals are a separate capability
and must not be represented as managed Agents.

### Use progressive Team Help and Context

The Runtime Team command registry is the source of truth for both authorization
and authenticated `team --help`. Keep root Help role-aware and disclose full
syntax only through command Help. Current responsibility and Team state belong
to `team context`; do not restore startup tutorials, repeated reminder
envelopes, message-history recovery, or generated `.hive/PROTOCOL.md` files.
Normal user input must remain unchanged at the PTY boundary, and recovery or
Provider compaction may inject only a bounded, secret-free Runtime Context.

### Use real integration coverage for runtime behavior

Changes involving HTTP routes, SQLite state, PTYs, terminal websockets, or the
`team` CLI need integration coverage that crosses the real boundary. Pure logic
can stay in `tests/unit`.

### Keep files focused

Avoid growing catch-all files. If a route, store, or component becomes hard to
scan, split it before adding unrelated behavior.

### Keep commits clean

Do not include AI-tool attribution in commits, PR bodies, or comments. Use a
normal human commit message that explains the change.

## Feature Contracts

Some parts of this repo are regression-prone because they coordinate the real
PTY, desktop UI, mobile UI, Relay, and local runtime. Before changing any of
these areas, read the relevant contract first and keep the behavior compatible:

- Mobile terminal, takeover, input, Relay routing, and mobile file exchange:
  `requirements/mobile-remote-control/TERMINAL_CONTRACT.md`
- Mobile terminal strategy:
  `requirements/mobile-remote-control/TERMINAL_UX_STRATEGY.md`
- Mobile remote test matrix:
  `requirements/mobile-remote-control/TEST_PLAN.md`
- Terminal ownership decision record:
  `docs/adr/0001-mobile-terminal-ownership.md`

This applies to changes under `web/src/mobile`, `web/src/terminal`,
`src/server/terminal-*`, `src/relay`, `web/src/relay-api.ts`, mobile actions,
and mobile file exchange code.

If a change intentionally alters a contracted behavior, update the contract or
ADR in the same change. If it only fixes or extends behavior, add or adjust a
regression test that would fail on the previous bug. Do not diagnose mobile
terminal display bugs by changing phone UI first when the desktop PTY or desktop
terminal is already in a bad state; establish which layer owns the broken state.

## Verification

Before submitting a non-trivial change, run:

```bash
pnpm check
pnpm build
pnpm test
```

If you skip a command, say exactly why.
