---
name: writing-plans
description: "Use this to write or revise an implementation plan from a specification. Audit the specification, repository, memories, and skills before proposing a concise phase blueprint; never write or edit the plan without explicit approval."
---

# Writing Implementation Plans

## Overview

Turn a validated specification into a concise, executable blueprint. A plan records the decisions, dependencies, boundaries, references, and verification needed to implement the work. It is not an implementation transcript, pseudo-code, or a line-by-line list of edits.

Do not draft, create, or revise a plan document until the user approves the proposed plan shape. A final plan contains no open questions, unchosen alternatives, placeholders, or deferred material decisions. Set `Status: Ready` only after the readiness gate passes.

## The Process

### 1. Establish the planning source

- Identify the source specification and its intended outcome, scope, constraints, and completion criteria.
- Inspect the relevant repository state, source files, documentation, interfaces, tests, configuration, and recent changes.
- For a revision, also inspect the existing plan, its source specification, and the current implementation state.
- Treat the specification and any existing plan as inputs to verify, not as authoritative descriptions of the system.

### 2. Audit decisions before planning

- Verify every material claim the proposed work relies on: current behavior, file paths, APIs, data models, dependencies, conventions, permissions, security properties, and operational constraints.
- Separate verified decisions from unsupported assumptions, incorrect or stale claims, opinions presented as requirements, and missing decisions.
- Trace dependencies so later phases do not rely on an unverified premise.
- Confirm that the proposed approach addresses the stated outcome without hidden scope expansion, architectural conflict, unnecessary compatibility work, or security risk.
- For persisted configuration, preferences, visibility, entitlements, or access-control data, explicitly audit: absent-row and absent-key defaults; explicit false or zero semantics; malformed and wrong-type values; preservation or intentional removal of unknown stored fields; read/write/cache round trips; and authorization at every access path. Resolve or flag these before considering architecture or UI preferences.
- Do not predict generated-code or framework behavior. Verify it against existing generated evidence or authoritative documentation; otherwise classify it as unverified and resolve it before planning dependent work.
- Stop on every material defect or unresolved decision. Present evidence, impact, and a recommended resolution; wait for the user to decide. Do not hide it in the plan as an open question.
- When the source permits multiple implementation paths, do not select one by inference. Record the user's confirmed choice and its source before planning dependent work.
- Do not proceed until every material decision is resolved and the plan can be implemented without inventing behavior.

### 3. Audit memories and skills

Before proposing the plan or asking the user to resolve a decision:

- Inspect all available durable memories. Identify every memory that constrains the work, record its key rule, and map it to the affected phase or phases.
- When the investigation produces a durable, non-obvious rule that would prevent future mistakes, save a concise new memory before planning. Do not save one-off task details or facts already captured elsewhere.
- Inspect available skills. Identify the skills required to plan, implement, verify, or review each phase.
- Include a consolidated execution-prerequisites section in the proposed plan. It must name the applicable memories and required skills, and state that the implementer must load the relevant skills before touching each phase.
- Repeat the applicable memory and skill references in each phase. Do not force irrelevant guidance into a phase. A missing applicable mapping is a planning defect, not an omission to leave for the implementer.

### 4. Resolve decisions one at a time

When the audit finds blockers:

- Report all material blockers concisely, prioritizing security, data integrity, irreversible changes, and upstream dependencies before interface or implementation preferences.
- Before asking for a decision, begin with an **Audit context** line naming the applicable memories and skills inspected or loaded; if none apply, say so. Cite the source of every claimed user preference, constraint, or prior decision; do not assert "the user said" without evidence from the conversation, a memory, or a document.
- Ask exactly one question: the highest-priority unresolved decision. Lead with a recommended option and evidence-based reasoning. Do not end with several independent "Which?" questions.
- Wait for the answer, re-audit every dependent assumption, then ask the next highest-priority decision if one remains.
- Do not propose or write a phase blueprint while any blocker remains.

### 5. Required blocker response

When one or more material blockers remain, respond in this order and stop after the single decision request:

1. **Audit context** — applicable memories and skills inspected or loaded.
2. **Verified facts** — concise, evidence-backed findings.
3. **Blockers** — every material defect, ordered by security, data integrity, irreversible changes, and dependency impact. For persisted data, include a **Persistence boundary trace** covering missing row/key, explicit false or zero, malformed values, unknown fields, database decode, cache decode, write round-trip, and authorization.
4. **Decision required now** — exactly one highest-priority unresolved decision, with a recommended option and evidence-based reasoning.

Do not include phases, a blueprint, a summary of several decisions, an invitation to choose multiple options, or language that leaves a source-listed alternative to the implementer. Do not ask for approval to write a plan until every blocker is resolved.

### 6. Propose the blueprint before writing

Present a concise pre-write proposal containing:

- The validated goal, in-scope work, and explicit exclusions.
- The ordered phases, their outcomes, dependencies, and the decisions each depends on.
- The execution prerequisites: source specifications/references, applicable memories, required skills, and baseline verification assumptions.
- Any risks, migrations, security implications, irreversible actions, or rollout constraints. Never describe these as zero-risk.
- The test seams and cases required by every behavior-changing phase, plus each mutation's normal-request, HTMX-request, and error-response contract where applicable.

Ask for explicit approval to create or revise the plan document. Do not write or edit a plan file before receiving it.

For a revision, clearly show what will change in the existing plan, why, and which phases or decisions are affected. Obtain approval before editing it.

### 7. Write a concise phase blueprint

After approval, write only the information needed to preserve execution intent. The plan should normally contain:

1. **Goal and scope** — intended outcome, boundaries, and exclusions.
2. **Decision record** — every material decision, its source, and confirmation that the user chose it where the source allowed alternatives.
3. **Execution prerequisites** — source references, applicable memories, required skills, and the instruction to load each phase's skills before implementation.
4. **Phases** — ordered, contained units of work. Each phase includes:
   - purpose and completed outcome;
   - dependencies and already-decided constraints;
   - applicable memories and skills;
   - relevant files, documents, interfaces, or external references;
   - implementation steps only where they preserve a necessary decision or ordering;
   - test changes and cases, when the phase changes behavior, data, or a boundary;
   - normal-request, HTMX-request, and error-response behavior for mutations, when applicable;
   - phase-specific verification and acceptance criteria.
5. **Final verification** — cross-phase checks required to establish that the goal is complete.

Use exact paths and references when they are known and material. Refer to established patterns rather than duplicating their implementation. Name files only when evidence supports their relevance.

### 8. Keep plans useful

- Prefer multiple coherent phases over a single undifferentiated checklist.
- Keep each phase contained: it should have a clear outcome and avoid unrelated cleanup or speculative work.
- Include multiple steps within a phase only when ordering, coupling, or a critical decision makes them necessary.
- Omit mechanical line-by-line edits, routine boilerplate, generated-code detail, and obvious commands unless they carry risk or preserve a decision.
- Do not include implementation alternatives after a decision has been made.
- Do not use a plan to postpone decisions. Resolve them with the user first.
- Do not substitute a passing command or a manual smoke test for planned automated test coverage.
- Use only verification commands supported by the repository's documented workflow and operational constraints.
- Do not commit the plan document unless the user explicitly asks.

## Readiness Gate

Do not create, revise, or mark a plan `Ready` unless all of the following are true:

- Every material claim is verified and every material decision has a recorded source; user-confirmed decisions are recorded where alternatives existed.
- No open questions, placeholders, unchosen alternatives, or scope-dependent "may" statements remain.
- Execution prerequisites name all applicable memories and required skills globally and at the relevant phase.
- Each behavior-changing phase identifies required automated test work; each applicable mutation defines normal, HTMX, and error behavior.
- Verification commands have been checked against repository guidance.

If any item fails, stop for clarification rather than writing a partial or nominally-ready plan.

## Revision Rules

When revising an existing plan:

- Re-audit the original assumptions against the current codebase and specification.
- Identify stale references, completed work, changed dependencies, and decisions invalidated by new evidence.
- Present the exact intended revision for approval before changing the file.
- Preserve valid decisions and remove obsolete content rather than accumulating compatibility notes or historical clutter.
- The revised plan must satisfy the same no-open-questions standard as a new plan.

## Key Principles

- **Blueprint, not transcript** — preserve intent and decisions, not every keystroke.
- **Evidence before structure** — verify the system before deciding phases.
- **No poisoned premises** — resolve incorrect, incomplete, or opinionated inputs before planning dependent work.
- **One decision at a time** — prioritize blockers, recommend a resolution, and wait before asking the next question.
- **No open questions** — a plan is ready only when every material decision is made.
- **Memories and skills are prerequisites** — audit, reference, and load them where they apply.
- **Approval before documentation changes** — the user approves both new plans and revisions before files change.
- **Contained phases** — each phase has a bounded outcome and proportionate verification.
- **Execution-ready handoff** — an implementer can follow the approved blueprint without re-litigating design decisions.
