# Domain Docs

How engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repo root
- Relevant ADRs under `docs/adr/`
- Relevant feature contracts under `requirements/`

Proceed silently if a referenced optional document is missing. Do not invent new domain language when `CONTEXT.md` already defines a term.

## File structure

This repo uses a single-context layout:

```text
/
|-- CONTEXT.md
|-- docs/
|   |-- adr/
|   `-- agents/
|-- requirements/
`-- src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, hypothesis, test name, or refactor proposal, use the term as defined in `CONTEXT.md`. If a needed concept is missing, record the gap instead of silently inventing a synonym.

## Flag ADR conflicts

If a proposed change contradicts an existing ADR, say so explicitly and explain why the ADR should be reopened.

