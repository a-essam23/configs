# Pi worktree handoff

**Status:** Ready

## Goal and scope

Add a global Pi workflow that creates a Git worktree and replaces the current Pi runtime with a fork of the current conversation rooted in that worktree. Relative `read`, `edit`, `grep`, and shell paths must then resolve in the worktree without tool overrides or `process.chdir()`.

In scope:

- `/worktree <branch>`: create and switch.
- `/worktree switch <branch>`: resume an existing worktree's latest Pi session.
- `worktree_handoff` agent tool: ask for concise confirmation, then queue the same command.
- Tests and package-version alignment needed for the supported Pi session API.

Out of scope: Ghostty/tmux launches, parallel Pi processes, detached HEADs, worktree cleanup/listing, setup hooks, dependency sharing, secret or environment-file copying, patch copying, automatic `.gitignore` changes, and a dry-run mode.

## Decision record

- Worktrees live at `<primary-repository>/.worktrees/<branch>`, shared with Neovim's existing `.worktrees/{branch}` convention in `nvim/lua/plugins/worktrees.lua:6-10`.
- The supplied branch name is also the relative worktree path; e.g. `feature/auth` creates branch `feature/auth` at `.worktrees/feature/auth`.
- Creation bases the new branch on the current checkout's `HEAD`, even if that checkout is dirty. Git state and local files are not copied; the conversation is copied only.
- `/worktree <branch>` is an explicit manual mutation and does not ask for confirmation.
- The agent tool confirms only the base revision and target path, then queues `/worktree <branch>` with `expandPromptTemplates: true` and `deliverAs: "followUp"`.
- Creation waits for the current agent to settle, then requires a materialized persisted source session (at least one completed assistant response). It refuses from `--no-session` or an unmaterialized fresh session rather than silently discarding conversation history. Switching an existing worktree remains available.
- `/worktree switch <branch>` resumes the worktree's latest saved session. If it has no saved session, it forks the current materialized session into that existing worktree, then switches.
- If Git worktree creation succeeds but session fork/switch fails, preserve the new worktree and branch; report the failure and let the user switch later.
- Pi 0.85.1 is the required API baseline. Align `pi/extensions` from its currently declared 0.74.0 version before using the command-expansion option.
- The user explicitly excluded a dry-run mode for this interactive workflow, overriding the general dry-run preference for this feature.

## Execution prerequisites

- Read Pi's installed extension/session API docs before each implementation phase, especially `/Users/ae/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `session-format.md`.
- Use the installed Pi 0.85.1 APIs: `SessionManager.forkFrom()` and command-context `switchSession()`; do not use private runtime APIs or mutate `process.cwd()`.
- Load `executing-plans` before implementation and `review` before final review. Reload `pi-docs` if Pi API behavior is uncertain.
- Apply memories: check memories before implementation; give the user a pre-flight brief before each execution phase; keep the feature narrow; use named intermediate values; retain a distinct worktree/session layer rather than path-rewriting built-in tools; remove obsolete version assumptions instead of adding compatibility wrappers.

## Phase 1 — Align dependencies and establish tests

**Outcome:** Extension source type information matches the installed Pi runtime, and the package has an automated test command.

- Update `pi/extensions/package.json` and `pi/extensions/package-lock.json` to use `@earendil-works/pi-coding-agent` 0.85.1.
- Add a minimal Node built-in TypeScript test command using Node 24's type stripping; do not add a test framework dependency.
- Add focused test support under `pi/extensions/test/` for worktree helper logic and Git integration using temporary repositories.

**Relevant memories/skills:** check-memories-before-building, pre-flight-before-execution, no-compat-wrappers, simple-current-contracts; `executing-plans`, `pi-docs`.

**Verification:** `cd pi/extensions && npm test` passes.

## Phase 2 — Implement safe Git and session handoff primitives

**Outcome:** A dedicated worktree module resolves the shared root, validates a branch, creates a worktree, forks the session at the target cwd, and switches only through Pi's public command context.

- Add `pi/extensions/workflow/worktree.ts`; register it in `pi/extensions/workflow/index.ts`.
- Resolve the primary repository from Git's common directory so invoking Pi from an existing linked worktree still uses the same primary `.worktrees/` root.
- Validate branch names with Git and require target paths to remain under `.worktrees/`; invoke Git with argument arrays rather than shell interpolation. Refuse pre-existing target paths/branches instead of forcing or resetting them.
- Implement `/worktree <branch>`: wait for agent settlement; require a materialized source session; inspect the current `HEAD`; add a branch worktree; use `SessionManager.forkFrom(currentSessionFile, targetPath)`; switch to the forked session using `ctx.switchSession()`.
- Implement `/worktree switch <branch>`: verify the named path is a registered Git worktree; resume its latest saved Pi session, or fork the current materialized session into it when none exists, then switch.
- Treat `--no-session`, non-Git directories, invalid names, Git failures, existing worktrees, session-fork failures, and canceled session switches as visible errors with no destructive rollback.

**Relevant memories/skills:** proportion-over-pattern, simple-current-contracts, coding-style, pre-flight-before-execution; `executing-plans`, `pi-docs`.

**Tests:** temporary-repository coverage for primary-root resolution, nested branch paths, invalid/path-escaping names, existing worktree refusal, successful Git creation, dirty-source allowance without file transfer, materialized-session requirement after agent settlement, and preservation of the created tree when later session work fails.

## Phase 3 — Add the agent request bridge

**Outcome:** The agent can request the same handoff without direct cwd mutation or duplicate Git/session logic.

- Register `worktree_handoff` with a strict branch parameter.
- Resolve and validate the proposed base and path before prompting. In interactive mode, request confirmation showing only those two values; in non-interactive mode, return an error without mutation.
- After confirmation, queue `/worktree <branch>` as a follow-up with command expansion enabled. The slash command remains the single mutation/session-switching implementation.
- Return a compact tool result explaining whether the handoff was queued, canceled, or rejected.

**Relevant memories/skills:** simple-current-contracts, coding-style, pre-flight-before-execution; `executing-plans`, `pi-docs`.

**Tests:** agent-tool confirmation acceptance/cancellation, exact queued command/options, and non-interactive refusal. Verify no direct `process.chdir()` or built-in file-tool override is introduced.

## Final verification

1. Run `cd pi/extensions && npm test`.
2. In a disposable Git repository, manually verify `/worktree feature/auth` leaves source modifications untouched, switches Pi to `.worktrees/feature/auth`, and allows relative file operations there.
3. Verify `/worktree switch feature/auth` returns to the worktree session.
4. Verify an agent invocation of `worktree_handoff` displays only base/path confirmation and, after approval, follows the same handoff path.
5. Review the diff to confirm no Ghostty launcher changes, `.gitignore` edits, cleanup behavior, local-file copying, or dry-run interface were added.
