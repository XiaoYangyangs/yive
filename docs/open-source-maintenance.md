# Open Source Maintenance

This document records the maintenance rules for the public Yive source mirror.
The public repository is a sanitized distribution surface. It is not the
private development workspace and must not inherit private machine paths,
deployment defaults, personal domains, credentials, terminal logs, or runtime
state.

## Repository Model

- The private development repository is the source of active product work.
- The public repository receives reviewed, sanitized source snapshots or small
  public-safe commits.
- Treat the public repository as independently cloneable and buildable.
- Keep the public history clean enough that a future visibility change does not
  expose old private data.

## Sync Rules

Before syncing from a private workspace:

1. Decide whether the change should be public.
2. Remove private-only defaults, local paths, device names, domains, tokens,
   logs, generated runtime state, APKs, keystores, and signing properties.
3. Replace real deployment examples with neutral examples such as
   `relay.example.com`, `203.0.113.10`, `<admin-token>`, and
   `<release-cert-sha256>`.
4. Do not commit private sync notes, local handoff files, or personal machine
   setup instructions.
5. If a temporary private remote is used for comparison, remove it before any
   history scan.

Use ordinary commits for small public-safe edits. Use a clean root snapshot
when private data, placeholders, or misleading metadata have already entered the
public branch history.

## Required Checks

Run these before pushing public changes:

```bash
pnpm check
pnpm pack:check
```

Run focused tests when the change touches behavior. Run `pnpm build` for
runtime, frontend, packaging, or deployment changes.

For the full publish flow, use the release checklist:
[English](./release-checklist.en.md) |
[Chinese](./release-checklist.zh-CN.md).

Also run two scans:

- A working-tree scan for private paths, personal domains, placeholder
  repository names, and known private project names.
- A Git-history scan across every reachable public commit for the same patterns
  plus common token, key, and private-key signatures.

If either scan finds a real issue, fix the current files first. If the issue is
present in public history, rewrite the public branch to a clean snapshot before
publishing or changing repository visibility.

## GitHub Push Fallback

Prefer normal Git push:

```bash
git push origin main
```

If the local network cannot use Git transport but GitHub API access works, it is
acceptable to update the public repository through the GitHub API after these
conditions are true:

- The intended local tree has passed the required checks.
- The current remote head was read immediately before the update.
- The update is a fast-forward for ordinary commits, or an intentional clean
  history replacement for a sanitized public snapshot.
- The local refs are aligned to the remote commit afterward.

After any API-based update, verify the remote head, scan the reachable public
history again, and confirm the local branch is aligned with `origin/main`.

If GitHub OAuth cannot update workflow files because the local token lacks the
`workflow` scope, a repository-scoped write deploy key may be used as a
temporary push path. Keep that key dedicated to this repository, store only the
private key on the local maintainer machine, and remove the deploy key from
GitHub once normal OAuth or SSH maintainer access can update workflows.

## Do Not Publish

Never publish:

- Real credentials, tokens, webhook secrets, private keys, keystores, or signing
  passwords.
- Private terminal transcripts, agent session identifiers, runtime databases,
  or workspace state.
- Local absolute paths, personal machine names, or private project directory
  names.
- Private deployment domains, server IPs, or production-only config defaults.
- Generated app packages, build caches, dependency folders, or temporary
  verification clones.

## Release Readiness

Before making the repository public or publishing a package:

1. Confirm the repository metadata points at the intended public repository.
2. Clone or download the remote source into a fresh directory.
3. Run install, checks, focused tests, build, and packaging verification from
   that fresh copy.
4. Run working-tree and history scans on the final remote contents.
5. Confirm the GitHub visibility, issue reporting, security policy, and license
   are intentional.
