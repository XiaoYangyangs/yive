# Yive Release Checklist

English | [中文](./release-checklist.zh-CN.md)

Use this checklist before syncing private development work into the public source repository, changing repository visibility, or publishing an npm package. The goal is to keep the remote repository independently cloneable and buildable without leaking private paths, domains, credentials, runtime state, or app packages.

## 1. Confirm Release Scope

- Confirm the change belongs in the public source repository.
- Remove private deployment defaults, real domains, real server IPs, local absolute paths, device names, and temporary debug files.
- Do not commit APKs, keystores, signing passwords, runtime databases, terminal logs, agent session identifiers, workspace state, or dependency caches.
- Replace real configuration with neutral examples such as `relay.example.com`, `203.0.113.10`, `<admin-token>`, and `<webhook-url>`.

## 2. Check Local Repository State

```powershell
git status --short --branch
git log --oneline --decorate --max-count=5
```

Confirm:

- The current branch is the branch you intend to publish.
- The working tree has no unrelated changes.
- The recent commits match the intended release.

## 3. Install And Basic Checks

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

For documentation-only changes, `pnpm build` may be skipped with a note. Run it for runtime, web, mobile, Relay, packaging, or release-file changes.

## 4. Focused Tests

Recommended lightweight pre-release subset:

```powershell
pnpm exec vitest run tests/unit/protocol-file.test.ts tests/cli/team-help.test.ts tests/cli/hive-cli.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
```

If the change touches terminals, workspaces, workers, Relay, file exchange, notifications, or mobile UI, add the relevant test files. Reserve full `pnpm test` for large refactors or final release confirmation.

## 5. Package Verification

```powershell
pnpm pack:check
pnpm pack:smoke
```

`pnpm pack:smoke` depends on `dist/`, `dist/bin/`, and `web/dist/`, so it must
run after a successful `pnpm build`. If you only need a quick view of what the
source package would include, run `pnpm pack:check` by itself, but do not treat
that as a replacement for smoke verification.

Confirm:

- The npm package can be generated.
- The package includes required `dist/`, `web/dist/`, `assets/`, `deploy/`, and documentation files.
- The package does not include `node_modules/`, local runtime data, APKs, keystores, temporary verification clones, or private configuration.

## 6. Local Runtime Smoke Test

Confirm the port is free, then start from built output:

```powershell
$port = 4519
Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
node dist/src/cli/hive.js --port $port
```

Open:

```text
http://127.0.0.1:4519/
```

Confirm the page loads. Stop the process after verification and confirm the port is released:

```powershell
Get-NetTCPConnection -LocalPort 4519 -ErrorAction SilentlyContinue
```

## 7. Sensitive Information Scans

Store the local scan regex in a file that is never committed, for example:

```powershell
$env:YIVE_RELEASE_SCAN_PATTERN = "$env:USERPROFILE\.config\yive-release-scan-pattern.txt"
```

The pattern file should cover:

- Local usernames, private directory names, and private project names.
- Private domains, server IPs, and webhook URLs.
- Common token, API key, private key, signing password, and keystore signatures.
- Runtime database names, log names, and temporary directory names that should not be public.

Working-tree scan:

```powershell
$pattern = Get-Content $env:YIVE_RELEASE_SCAN_PATTERN -Raw
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!web/dist/**' --glob '!vendor/**' --glob '!.git/**' --regexp $pattern .
```

History scan:

```powershell
$pattern = Get-Content $env:YIVE_RELEASE_SCAN_PATTERN -Raw
$commits = git rev-list --all
git grep -n -I -E $pattern $commits -- . ':!vendor' ':!dist' ':!web/dist'
```

If a real issue is found:

- Working tree only: fix the files and scan again.
- Public history: do not publish directly; rewrite the public branch to a clean snapshot, then scan again.

## 8. Fresh Clone Verification

Create a temporary directory outside the repository:

```powershell
$verifyRoot = Join-Path $env:TEMP "yive-release-verify"
if (Test-Path -LiteralPath $verifyRoot) {
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force
}
git clone git@github.com:<owner>/yive.git $verifyRoot
cd $verifyRoot
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm pack:check
pnpm pack:smoke
```

For private repository verification, use an authorized SSH key or deploy key. Never commit the deploy key private key.

## 9. Push And CI

```powershell
git push origin main
gh run list --repo <owner>/yive --limit 5
```

If a dedicated deploy key is required:

```powershell
$env:GIT_SSH_COMMAND = "ssh -i `"$env:USERPROFILE\.ssh\<repo-deploy-key>`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git push git@github.com:<owner>/yive.git main
```

After pushing, confirm:

- The latest GitHub Actions run is `success`.
- Local `main` is aligned with `origin/main`.
- The remote repository has no unexpected branches, tags, or old snapshots.

## 10. GitHub Repository Settings

Before publishing or changing visibility, check:

- Visibility matches the current stage: private, internal, or public.
- Issues, security policy, README, LICENSE, NOTICE, and TRADEMARK are correct.
- The default branch is `main`.
- Actions permissions and deploy key permissions follow least privilege.
- If the repository will become public, scan the final remote history first.

## 11. Release Record

After release, record:

- Release commit.
- Checks that were run.
- CI run result.
- Whether fresh clone verification was performed.
- Any skipped items and why they were skipped.

Put this record in a release issue, PR description, or maintenance log. Do not write private paths or private configuration into temporary files that may later be committed.
