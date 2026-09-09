# Repository cleanup

Status: complete. Independent reviews found no material regression; 194 tests,
strict typecheck, three builds, compiled help, and Markdown-link checks pass.

Simplify the September 9 TypeScript implementation without changing supported
commands, stored formats, provider ownership, or deployment rollback semantics.

1. Inventory tracked files and review every source area with function-design.
2. Remove superseded planning instructions and conflicting status checklists;
   retain a compact Git history index and the current release evidence.
3. Consolidate repeated config reads, recorded port mapping, receipt writes,
   and route-block interpretation. Remove capabilities with no callers.
4. Fix the readiness deadline that currently depends on provider cooperation.
5. Run focused public-behavior tests, the full isolated suite, strict typecheck,
   builds, and independent review of the final changes.

Use the existing public seams established in the rewrite plan: config documents,
runtime actions, provider operations, CLI subprocesses, and daemon HTTP. Add
characterization coverage before refactoring; reproduce changed behavior with
a failing public test before fixing it. Tests use temporary RIG_ROOT/provider
paths. This cleanup does not install, deploy, or alter the user's live Host.

Record findings, function contracts, file coverage, and verification in
`docs/reviews/2026-09-09-repository-cleanup.md`. Keep larger contract redesigns
explicit in that review instead of introducing speculative abstractions.
