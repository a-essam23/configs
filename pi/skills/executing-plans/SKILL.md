---
name: executing-plans
description: "Use this when implementing a written plan. Audit the plan against the codebase before accepting it, obtain explicit approval, execute incrementally, and pause on material deviations."
---

# Executing Written Plans

## Overview

Implement a written plan systematically without treating it as authoritative. Plans can contain incorrect assumptions, incomplete requirements, stale references, or opinionated solutions that lead to poisoned implementations.

Validate the plan against the actual system before changing anything. Do not fill in missing decisions by inference. If the plan is materially unsound, stop and resolve it with the user.

## The Process

### 0. Enforce execution prerequisites

Before accepting the plan:

- Read its execution prerequisites, source references, decision record, and phase-level memory and skill mappings.
- When durable memories and skills are available in the environment, inspect the available guidance. Verify that every applicable memory and skill is named globally and mapped to its relevant phases.
- Load skills required for auditing before the audit. Load each phase's required implementation skills immediately before touching that phase.
- Treat a missing prerequisite, absent phase-level mapping, unavailable required skill, or unrecorded material decision as a plan defect. Do not silently supply it.

### 1. Identify and audit the plan

- Locate the written plan and identify its intended outcome, scope, and completion criteria.
- Inspect the relevant repository state, source files, documentation, interfaces, tests, configuration, and recent changes.
- Verify every material claim the plan relies on, including file paths, APIs, data models, dependencies, conventions, permissions, current behavior, request/response behavior, test coverage, and verification commands.
- Classify plan content as:
  - **Verified facts** — supported by current evidence.
  - **Unverified assumptions** — plausible but not yet supported.
  - **Defects** — incorrect, stale, contradictory, incomplete, or impractical instructions.
  - **Opinions** — design preferences presented as requirements without a stated decision or constraint.
- Trace dependencies between steps. Flag any downstream work that depends on an unverified or defective premise.
- Check whether the proposed work addresses the stated outcome without hidden scope expansion, duplication, security risk, or conflict with established architecture.

### 2. Resolve material defects before execution

- Do not implement around an incorrect, incomplete, or opinionated plan item.
- Present the issue with evidence: the affected plan item, what the system actually shows, why the difference matters, and a recommended correction.
- Report all blockers concisely, prioritizing security, data integrity, irreversible changes, and upstream dependencies before interface or implementation preferences.
- Ask the user to resolve only the highest-priority missing decision, trade-off, or contradiction. Lead with a recommended resolution and evidence; do not bundle independent questions.
- Wait for the answer and re-audit dependent premises before asking the next decision.
- Cite the source of every claimed user preference, constraint, or prior decision. Do not assert "the user said" without evidence from the conversation, a memory, or a document.
- A plan's stated choice is not proof that the user approved it. If it selects among alternatives allowed by the source, require a recorded user-confirmed decision before accepting it.
- Validate that every behavior-changing phase plans the required automated test work, and that mutations define their normal-request, HTMX-request, and error-response behavior where applicable.
- Validate every planned command against the repository's documented workflow and operational constraints.
- Do not describe migrations, data changes, or other operational work as zero-risk.
- **Hard gate:** if any defect, ambiguity, missing test work, incomplete mutation contract, invalid verification command, or unverified prerequisite remains, report **Blocked — clarification required**. Do not present an implementation pre-flight or ask to begin work.
- Revise the execution approach only after the user confirms the correction.
- If the plan is not sufficiently actionable after review, do not begin implementation.

### 3. Present a pre-flight brief and get approval

Only after every hard-gate item is resolved, before writing code or modifying files, summarize:

- The validated goal and bounded scope.
- The ordered implementation steps and affected areas.
- Assumptions that were verified and any user-approved corrections.
- Risks, destructive operations, security implications, migrations, and rollback considerations.
- The verification strategy for each step and for final completion.

Ask for explicit approval to begin. Do not make changes before receiving it.

### 4. Execute incrementally

- Before each approved phase, present a phase pre-flight: its bounded scope, required skills loaded, applicable project rules and memories, expected verification, and any new risks or assumptions.
- Do not touch the phase until every newly identified decision or concern is resolved with the user.
- Work through the approved steps in order.
- Before each step, inspect nearby code and follow local conventions, abstractions, and existing libraries.
- Change only what the approved step requires. Do not add speculative cleanup, refactors, compatibility layers, or adjacent features.
- Verify each completed step with the narrowest relevant check, then report the result before continuing.
- Keep the user informed of meaningful progress, failures, and findings.

### 5. Pause on deviations

Stop and ask the user before continuing when:

- Evidence contradicts the plan or a required premise remains unverified.
- A step requires a decision the plan does not make.
- A proposed fix changes scope, architecture, data formats, public behavior, or security posture.
- Verification fails and resolving it needs work not covered by the approved plan.
- The work involves destructive actions, irreversible migrations, credentials, production systems, or other elevated risk.

State what changed in understanding, provide evidence and options where useful, and wait for direction. Never silently substitute an implementation.

### 6. Verify and report completion

- Run the proportionate final verification defined in the pre-flight brief.
- Review the completed work against the validated goal and each approved plan item.
- Report changed files, verification commands and results, plan deviations approved by the user, and any remaining limitations or follow-up work.
- Do not commit, deploy, or perform other external actions unless the user explicitly asks.

## Key Principles

- **Plans are hypotheses, not authority** — verify them against the current system.
- **Evidence before implementation** — cite the source of material conclusions.
- **Defects propagate** — resolve flawed early premises before executing dependent steps.
- **No inferred decisions** — ambiguity requires clarification, not invention.
- **One decision at a time** — prioritize blockers, recommend a resolution, and wait before asking the next question.
- **Prerequisites are enforceable** — required memories, skills, tests, and response contracts must be present before work begins.
- **Approval before mutation** — obtain explicit user approval after the pre-flight review.
- **Incremental verification** — prove each step before building on it.
- **Bounded scope** — implement the approved plan, not adjacent ideas.
- **Transparent deviations** — pause and surface changes in understanding immediately.
