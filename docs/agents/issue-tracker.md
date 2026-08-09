# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- When an implementation issue is completed, update its `Status:` to `done` and append a `## Comments` entry with the completion summary, key commits, and verification commands that passed

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/`, creating the directory if needed.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or issue number directly.

## When implementation completes

If the work came from `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, close the loop before final handoff:

1. Change `Status:` to `done`.
2. Add or update `## Comments`.
3. Record the implementation commit hash or hashes.
4. Record the verification that passed.
5. Leave explicit notes for any skipped or incomplete verification.
