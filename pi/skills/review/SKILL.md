---
name: review
description: Use when the user asks to review, audit or clean up work in progress — "review my branch", "review what we built", "any duplication?", "is this over-engineered?", "did we reinvent anything?", "check if this follows our patterns". Audits unmerged changed code for duplicated logic, utils and constants, types restated instead of derived, type assertions and `any`, sqlc types leaking past the repository layer, reinvented templ components and design tokens, misplaced state, layering violations, sibling inconsistency and naming drift, gratuitous code, dead weight, and changes that are more invasive than the feature required. Checks the work against its plan document where one exists, treating the plan as a hypothesis rather than authority. Reports findings; does not edit or commit unless told to.
---

# Review

## What this is

A reuse audit, not a bug hunt. Assume the code under review was written fast by someone who
did not read the rest of the repo, and that somewhere in the repo the thing they just wrote
already exists. Your job is to find it.

Two questions, asked of every changed file:

```
-> did this reinvent something the repo already has?
-> is this the least code and the least disturbance that solves the problem?
```

Everything below serves those two questions.

## Scope

Everything the user has not yet merged — committed, staged and unstaged. Not just the last commit.

```bash
git merge-base main HEAD          # committed
git diff --stat $(git merge-base main HEAD)
git diff --stat HEAD              # staged + unstaged
git status --porcelain            # untracked
```

Untracked files matter most: a brand new file is where reinvention happens.

Read `RULES.md` and `AGENTS.md` first. They name the canonical locations — domain types in
`internal/domain/types.go`, interfaces in `ports.go`, context keys in `context.go`, request DTOs in
`internal/input/`, shared helpers in `handlerutil/`, SQL in `queries/` (sqlc), field constraints in
`validation.Limits`, middleware one concern per file, design tokens in `DESIGN.md`. An audit that
does not know where things belong cannot tell you something was rebuilt in the wrong place.

## The plan, if there is one

Some of this work was planned before it was written; plenty was not. Spend one look: `docs/plans/`,
then the conversation, then a basename matching the branch or ticket. If several match, ask which.

**No plan is the ordinary case, not a gap.** Most changes never warranted one. Review the code on
its own terms, do not report the absence as a finding, do not ask for one to be written, and skip
the rest of this section. The plan is extra evidence when it exists; every other axis stands on
its own without it.

When there is one, read its goal, scope, exclusions, decision record and phases — then check three
directions, in this order:

```
-> code beyond plan — scope nobody authorized
-> code against plan — was a recorded decision quietly substituted?
-> plan against code — was the plan itself wrong, and the code faithful to it?
```

**A plan is an approved hypothesis, not proof the result is right.** Three failures, all worth
reporting:

- **The implementation exceeded the plan** — work listed under exclusions, or feature-specific
  machinery that a later phase was supposed to own arriving before any consumer exists. This is the
  failure that actually happens: an "unapproved optimization" the user never asked for, a cache
  namespace split, an extra endpoint, a generalized helper with one call site. It is provable
  rather than a matter of taste, and the plan makes it provable. Report it first and loudest;
  the user's history says this is the #1 failure mode.
- The implementation diverged from a decision the plan records. Not automatically wrong — the
  implementer may have found something the planner missed — but an unrecorded divergence is a
  finding, and the plan's decision record is the evidence.
- The implementation faithfully followed a plan item that the codebase contradicts. Here both the
  plan and the code need fixing; blaming the diff alone sends the user back to the same wrong step.

Also check `docs/roadmap/` status files against the diff: a phase marked complete whose work is not
there, or finished work still marked pending.

Do not edit the plan, mark phases, or update the status line. Report the mismatch and let the user
decide whether the plan or the code moves.

## Generated SQL types never leave the repository layer

The one rule here that is not a matter of degree. Stop and report it above everything else.

sqlc output is a map of the whole schema — every table, every column, every enum. There is no
client bundle to leak into, but there is coupling: the moment a handler, service or template
imports `queries/` — directly, or worse, via a row type a repository returned — the schema is
pinned into layers that were supposed to be stable, and the contract between service and handler
silently rewrites itself with the next migration.

- A **repository** converts sqlc types to domain types. That conversion is the only place the
  generated types may appear. `internal/domain/types.go` is the contract the rest of the app sees.
- A **handler, service or template** that receives or returns a `sqlc.*` row, or imports `queries/`
  at all, is a finding, full stop.
- Boundary serialization (JSON DTOs, request shapes) is not domain behavior; it lives at the
  boundary, never in `domain/` (see `docs/audit/2026-07-21-json-boundaries.md`).

This is exactly where the axes below stop. Derive from the database in the repository layer; hand
the service layer a domain type.

## Least code, least blast radius

Take the first option that works, in this order:

```
-> YAGNI — is the change needed at all?
-> existing code, unchanged
-> stdlib or native platform feature
-> an already-installed dependency
-> the smallest correct implementation
```

Then, for where that code goes, prefer the option that touches the fewest existing call paths:

```
-> call existing code from one new site
-> add a small helper, call it from one site
-> add an optional parameter whose default is exactly today's behaviour
-> change a function's return shape or default behaviour     <- justify
-> restructure the module, introduce a new layer or abstraction  <- justify
```

**A new step in an existing flow is an addition, not a rewrite.** Given a service method that must
now also record an audit row:

- Wrong — change `CreateChapter()` to return `(Chapter, AuditRow)` (or take a recorder param).
  Every caller now unpacks a shape it did not ask for, every test updates, and paths that never
  wanted an audit row pay for it.
- Right — add `recordAudit(ctx, chapter)` and call it on one line inside `CreateChapter()`.
  One new function, one new line; every existing caller and test untouched.

The test: **if a change forces edits in files that have nothing to do with the feature, it is the
wrong change.** Ask what the diff would look like if the feature were reverted — an additive change
disappears cleanly; an invasive one leaves scars.

### The counter-rules

Least code is not a licence to inline everything or to ship less than the problem needs:

- If the same knowledge now lives in two places, extract it. DRY governs knowledge, not
  control-flow shape — small duplication across branches is fine, a rule expressed twice is not.
- A change being small never justifies skipping an abstraction that genuinely belongs.
- Never trade away validation, security, error handling, accessibility or necessary tests to
  shrink a diff. Flag it if the diff got small by dropping one of those.

### Speculative generality

Flag anything built for a caller that does not exist: a config flag with one value, an interface
with one implementer, a service method no call site uses, a params field no call site passes, a
wrapper around a single call, "so we can add more channels later". Delete it and say so.

## What to look for

Run each axis over the diff. For every new symbol, search the whole repo, not the folder it landed in.

**1. Duplicated logic.** The same rule, computation or validation expressed twice — worst across a
package boundary, where a handler re-implements what a service or shared package already owns and
the two will silently drift. Grep the distinctive identifiers and the core expression, not the
function name.

**2. Restated types.** Types are derived, never retyped. A handler-local struct duplicating a
domain type, a string enum re-declared where `domain` already has constants, a repository
hand-mapping rows that sqlc already generates — every one is a finding, and every one drifts
silently the moment the schema changes. Walk the ladder before accepting any new type — sqlc
generated types, then domain types, then `input`/params types, then `validation.Limits` — and add
one only for what none of them can express.

**3. Type assertions and `any`.** `any`/`interface{}` where a concrete type exists, a `.(T)`
assertion silencing a wrong type instead of fixing it, `//nolint` standing in for a real check, a
swallowed error (`_ = err`, an empty error branch), `panic` in a request path. Treat every one in
the diff as a finding until proven otherwise. A fix is nearly always available: parse the value at
the boundary, return concrete types, make the function generic. Where one is genuinely unavoidable
— an untyped third-party surface, a test double — it belongs on one line at the narrowest boundary,
with the why, never threaded down the call path.

**4. Duplicated utils and constants.** Search `handlerutil/`, `validation.Limits` and the shared
packages by intent, not by name — `FormatCount`, `ShortNumber` and `prettyCount` are the same
function. Same for a status map or option list rebuilt inline. RULES.md: shared parsing,
validation and helpers are extracted from the first use, never scoped as one-handler shortcuts.

**5. Reinvented components and tokens.** Hand-rolled templ markup where a component already
exists; hardcoded colours, spacing or radii where `DESIGN.md` tokens exist. Inventing a token, or
editing a global one to fix a local problem, is a finding — it moves the blast radius to the
whole app.

**6. Misplaced state and threading.** A value threaded through handler structs or params that do
not read it; the same derived logic repeated in sibling handlers (extract a helper); repeated
per-viewer DB lookups where a cached map with exact invalidation belongs (RULES.md, Caching);
a context key used where an explicit parameter would do.

**7. Layering violations.** The dependency direction is `handler → service → repository → domain`,
never reversed. Services importing `net/http`; handlers decoding resource IDs inline instead of the
resource-resolution middleware; auth decisions outside `mw.Can` in handlers; bare `strconv.Atoi` +
`len()` in a handler where an `input` type belongs; business invariants checked in handlers instead
of services; env lookups outside `internal/config`; direct sqlc outside repositories.

**8. Dead weight and verbosity.** Exports, parameters, branches and files the diff orphaned; code
kept "just in case"; a compatibility wrapper kept after the thing it wrapped was removed (RULES.md
says delete them); comments narrating what the line already says; a ticket number in a comment;
magic literals; nesting a guard clause would flatten.

**9. Sibling consistency and naming.** New code must look like its siblings, not like itself.
Before judging a new file, read the other files in the same package and the other repositories or
services in the same layer — then flag structural divergence: a repo that retains `pool` where
siblings retain only `q` and `cache`; a different cache pattern from every other repository; a
domain concept spread across several files where siblings keep one file per concept; a handler
set up differently from sibling handlers. Naming is part of this: method verb patterns
(`List`/`Find`/`Create`), the `Unscoped` suffix — which means *includes soft-deleted rows*, and
nothing else — `Params` structs with `Defaults()`, symmetric cache-key formats (siblings agree on
`comment:list` vs `review:pub:list`), and the RULES.md terminology ban (no `moderation`/`admin`
words anywhere). A name that needs explaining is a name that doesn't fit; propose the sibling
name instead.

**10. Gratuitous code — "what's the point of this?".** Ask the user's question before they do, of
every added symbol: a helper with one call site, a defensive check that cannot trigger, a logging
line for a path the user will never debug, error-wrapping indirection around a direct call, a
wrapper around a single call, a parameter no call site passes. If the honest answer is "nothing"
or "future", it is a finding. This is the most common micro-complaint in the user's history —
they will ask "what's the point of this?" about anything that does not visibly earn its place.

## Project rules the diff may violate

RULES.md is authoritative; read it. The violations that actually show up in diffs:

- **Terminology.** No `moderation`, `moderator`, `mod`, or `admin` in code, comments, keys, labels,
  URLs, logs or copy. Name the action: ban, removal, resolution, outcome.
- **Validation.** `utf8.RuneCountInString`, not byte length; limits referenced from
  `validation.Limits`; mutation input independently validated on the server even when the form
  constrains it.
- **Mutations.** htmx mutations reload the list and return the smallest fragment capturing the
  state change — never a full-page re-render. State-changing routes stay behind global CSRF and
  submit the token. Files validated by content, not client MIME, with size/dimension limits and the
  storage guard. User HTML sanitized before persistence; trusted raw HTML wrapped in `hx-disable`.
- **Caching.** Responses varying by htmx headers, auth, permissions or target send `Vary` and are
  not publicly cached unless user-independent; cacheable fragments carry no user-specific state;
  every mutation invalidates exactly the affected keys and scopes — trace the invalidation for
  every mutation in the diff, a mutation without its invalidation is a stale-data bug.
- **Errors.** Rendering and error paths go through `handlerutil`; external-service failures return
  a safe user-facing result, preserve data integrity, and emit structured logs without credentials
  or private content.
- **Tests.** `Test<Struct>_<Method>_<Scenario>`; integration tests use real Postgres via
  `testutil.NewTestDB(t)`, not mocks.
- **Migrations.** Schema-dependent code ships with its migration and rollback; SQL changes were
  run through `sqlc generate` before the code that calls them.

## Running it

For a diff over roughly fifteen files, or one spanning packages, fan out — one read-only subagent
per axis, each returning findings as `file:line`, the pre-existing thing that should have been
used, and its location. Keeps the main context clean and gives each axis full attention.

Subagents are confidently wrong. Open every claimed duplicate yourself before it reaches the user;
drop anything you cannot point at.

## Reporting

If the diff violates a RULES.md rule, say so explicitly — the project records rule deviations in
`docs/audit/`, but you do not write that file; the user decides. Otherwise: number each issue,
describe it concretely with `file:line`, then give lettered options — recommended first, "do
nothing" included where it is reasonable — with the effort, risk and maintenance cost of each.
Group by area, order by severity within it.

For every duplication finding, cite both sides: the new code and the thing it duplicates. A finding
without a second location is a hunch, not a finding.

Say plainly what is fine. A short review of a clean diff is the correct output.

## Rules

- Review only. Do not edit until the user explicitly asks; "review" never means "fix".
- Never `git add`, `git commit`, `git stash`, or create or switch a branch. The user commits.
- Do not report what the formatter, linter or `templ generate` owns.
- Fix what was reported. A review is not an invitation to redesign the feature.

## Not this skill

Correctness bugs, regressions and edge cases — report them for a `docs/bugs/` record, but this
skill is a reuse audit, not a bug hunt. Vulnerabilities — the RULES.md Security section governs;
raise them, never fix them silently. Visual design and interaction — `impeccable`.
Customer-facing wording — `voice`.
