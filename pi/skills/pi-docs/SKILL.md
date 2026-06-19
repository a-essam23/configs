---
name: pi-docs
description: Use when the user asks about pi itself, including Pi internals, SDK, extensions, themes, skills, prompt templates, TUI components, keybindings, custom providers, adding models, packages, settings, CLI behavior, or troubleshooting Pi.
---

# Pi Docs

Use this skill for questions about Pi itself.

## Documentation roots

- Main documentation: `/Users/ae/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- Additional docs: `/Users/ae/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs`
- Examples: `/Users/ae/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples`

## Routing

- Extensions: `docs/extensions.md`, `examples/extensions/`
- Themes: `docs/themes.md`
- Skills: `docs/skills.md`
- Prompt templates: `docs/prompt-templates.md`
- TUI components: `docs/tui.md`
- Keybindings: `docs/keybindings.md`
- SDK integrations: `docs/sdk.md`, `examples/sdk/`
- Custom providers: `docs/custom-provider.md`
- Adding models: `docs/models.md`
- Packages: `docs/packages.md`

## Rules

- Resolve `docs/...` under Additional docs, not the current working directory.
- Resolve `examples/...` under Examples, not the current working directory.
- Read relevant Pi `.md` files completely before answering or implementing.
- Follow cross-references to related docs when needed.
- Prefer official docs and examples over guessing from memory.
