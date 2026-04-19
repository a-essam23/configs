---
name: creating-code-patterns
description: Use when 3+ similar implementations follow the same structure, onboarding requires explaining conventions repeatedly, or code reviews reference "follow the pattern from X" — creates tested, reusable implementation guides in patterns/ directories
---

# Creating Code Patterns

## Overview

Code patterns are **focused, reusable implementation guides** stored in `patterns/`. Each pattern is a single markdown file with searchable frontmatter and concise implementation steps.

**Core principle:** Patterns enable consistent implementation without reverse-engineering existing code.

**REQUIRED BACKGROUND:** superpowers:test-driven-development — pattern creation follows RED-GREEN-REFACTOR.

## When to Use

- 3+ similar implementations following the same structure
- Onboarding requires explaining the same conventions repeatedly
- Code reviews keep saying "follow the pattern from X"

**Don't create for:** one-off solutions, standard practices documented elsewhere, simple abstractions (extract to shared code instead), project-specific config (put in AGENTS.md/CLAUDE.md).

## The Iron Law

```
NO PATTERN WITHOUT BASELINE TESTING FIRST
```

1. Give a subagent a task in the pattern's domain — **without** the pattern
2. Document where they struggle (wrong imports, wrong structure, missed conventions)
3. Write pattern addressing **those specific gaps**
4. Test again with pattern — verify they succeed

Write pattern before testing? Delete it. Start over. No exceptions.

## Pattern Structure

**Location:** `patterns/` in project root. Monorepos: `apps/<app>/patterns/` or `packages/<pkg>/patterns/` for domain-specific, root `patterns/` for cross-cutting.

**Naming:** kebab-case, action-oriented. One pattern per file. Max ~150 lines.

**Required frontmatter:**

```yaml
---
title: Creating Section Components
tags: [react, component, section, framer-motion, i18n]
when_to_use: >
  When creating a new page section with Framer Motion
  animations and next-intl internationalization
prerequisites: [nextjs-basics, tailwind-css]
related: [adding-framer-motion, configuring-i18n]
---
```

**Content structure:**

```markdown
## Quick Reference
2-3 line summary + key imports

## Implementation
### Step 1: [Action]
Code example with comments

### Step 2: [Action]
Code example with comments

## Common Variations
- Alternative A: [when to use]

## See Also
- [Related pattern](related-pattern.md)
```

**Content rules:** No narrative. Code examples must be complete and runnable. One excellent example beats many mediocre ones.

## Integration with Project Docs

- **AGENTS.md/CLAUDE.md = high-level conventions** (naming, structure, linting)
- **patterns/ = specific implementation** (exact code, step-by-step, copy-paste)

Don't duplicate what's in AGENTS.md/CLAUDE.md. Reference it:

```markdown
## Prerequisites
- Follow TypeScript naming conventions (see AGENTS.md)
```

Add pattern discovery to AGENTS.md:

```markdown
## Code Patterns
Before implementing features, check `patterns/` for existing guides.
```

## Anti-Patterns

| Anti-Pattern | Why Bad | Fix |
|---|---|---|
| Monolithic `PATTERNS.md` | Never read, bloats context | One file per pattern in `patterns/` |
| Narrative documentation | Not actionable | Concise steps with code |
| Missing frontmatter | Not discoverable or searchable | Always include required fields |
| Duplicating AGENTS.md | Stale when conventions change | Reference, don't copy |
| Pattern before baseline test | Unknown if it addresses real gaps | Delete. Start with RED phase |

## Checklist

- [ ] Baseline test: subagent attempted task without pattern, struggles documented
- [ ] Pattern addresses specific baseline failures
- [ ] Tested: subagent succeeds when following pattern
- [ ] Frontmatter complete (title, tags, when_to_use, prerequisites, related)
- [ ] Location correct (`patterns/kebab-name.md`)
- [ ] No duplication of AGENTS.md/CLAUDE.md content
- [ ] Under 150 lines, one focused pattern
- [ ] Code examples included and runnable
