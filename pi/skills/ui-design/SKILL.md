---
name: ui-design
description: Use when creating or substantially redesigning a web page, application screen, component, or visual interface where layout, hierarchy, and aesthetic quality matter
---

# Designing interfaces with visual feedback

## Core principle

Treat UI creation as an art-direction and review loop, not a one-shot coding task. Commit to a coherent visual point of view, build in small visual groups, inspect the result, and make targeted corrections.

## Before building

1. Understand the purpose, audience, primary action, content, and technical constraints.
2. Inspect existing context before inventing a system:
   - In Paper, use `get_basic_info`, `get_selection`, `get_tree_summary`, and existing tokens/fonts.
   - In a codebase, read the relevant routes, components, styles, tokens, and assets.
3. If the user has not supplied a design system, state a short design brief before implementation:
   - 3–5 plausible mood directions
   - The chosen mood and why it is not the first instinct
   - A role-based palette derived from that mood
   - Typography and size hierarchy
   - One sentence describing the composition
4. Use existing tokens, fonts, components, and content patterns whenever they exist. Do not replace a project’s design language with generic defaults.

## Commit to a visual direction

Choose one clear direction and execute it precisely. Use contrast deliberately:

- Create hierarchy with scale, weight, spacing, and density—not decoration everywhere.
- Prefer asymmetry, scale contrast, and meaningful negative space over uniform card grids.
- Derive colors from a concrete scene or material; use one primary accent and restrained secondary colors.
- Make small text readable. Contrast is non-negotiable.
- Use realistic content. Placeholder copy should expose layout problems, not hide them.
- Add personality through one or two intentional details, not a pile of effects.

For product interfaces, prioritize clarity and task flow. For marketing or expressive work, prioritize memorability without sacrificing usability.

## Build incrementally

Construct one visual group at a time: shell, header, navigation, hero, control group, one list row, footer, or decorative detail. Do not dump an entire page or component in one opaque operation.

Prefer composable layout primitives and stable relationships:

- Use flexbox, padding, and gap as the default layout tools.
- Use explicit slots for repeated icons, indicators, and trailing actions so vertical lanes align.
- Keep decorative absolute layers from blocking interaction.
- Reuse existing components or duplicate a known-good element before recreating it.
- Name meaningful layers and components.
- In Paper, use inline styles, CSS variables, and `write_html` for small groups; use targeted style/text/move operations for edits instead of rewriting whole sections.

## Review loop

After each meaningful section, render or screenshot the result and critique it before continuing. Evaluate:

- **Spacing:** Are related items grouped and major sections given enough breathing room?
- **Typography:** Is hierarchy obvious? Are line lengths and line heights comfortable?
- **Contrast:** Can every important element be read immediately?
- **Alignment:** Do shared edges and repeated vertical lanes line up?
- **Composition:** Is the focal point clear, or does everything have equal weight?
- **Fit:** Is anything clipped, overflowing, or collapsed at the target viewport?
- **Repetition:** Does repetition create rhythm without making the interface monotonous?

State a one-line verdict for each checkpoint, fix discovered issues, then proceed. Prefer targeted corrections over deleting and restarting. In Paper, use `get_screenshot` for review and release working indicators with `finish_working_on_nodes` when done.

## Red flags

Stop and reconsider when you are:

- Starting implementation without understanding the context or committing to a direction
- Reaching for a familiar dashboard/card pattern without a reason
- Adding gradients, shadows, colors, or decorative effects to compensate for weak hierarchy
- Building a whole page before seeing an intermediate result
- Using screenshots as a substitute for exact styles or structure when exporting to code
- Rewriting a working section when a focused edit would solve the problem
