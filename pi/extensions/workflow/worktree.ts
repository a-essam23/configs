import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PI_VCC_COMPACTOR, PI_VCC_COMPACT_INSTRUCTION } from "./pi-vcc-contract.ts";

export function primaryRepositoryRoot(commonGitDir: string): string {
	return dirname(resolve(commonGitDir));
}

export function worktreeDirectory(primaryRoot: string, branch: string): string {
	const root = resolve(primaryRoot, ".worktrees");
	const target = resolve(root, branch);
	const relativeTarget = relative(root, target);

	if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("Worktree branch must resolve inside .worktrees");
	}

	return target;
}

export function worktreeHandoffConfirmation(base: string, target: string): string {
	return `Base: ${base}\nPath: ${target}`;
}

export function worktreeHandoffCommand(branch: string): string {
	return `/worktree ${branch}`;
}

export function parseWorktreePaths(output: string): string[] {
	return output
		.split("\0")
		.filter((record) => record.startsWith("worktree "))
		.map((record) => record.slice("worktree ".length));
}

const WorktreeHandoffParams = Type.Object({
	branch: Type.String({ description: "Branch name and worktree path to create" }),
	compact: Type.Optional(Type.Boolean({ description: "Compact with pi-vcc before handing off" })),
});

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface RepositoryInfo {
	checkoutRoot: string;
	primaryRoot: string;
	head: string;
}

function gitError(result: GitResult, fallback: string): Error {
	return new Error(result.stderr.trim() || result.stdout.trim() || fallback);
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<GitResult> {
	return await pi.exec("git", args, { cwd });
}

async function getRepositoryInfo(pi: ExtensionAPI, cwd: string): Promise<RepositoryInfo> {
	const [checkout, commonDir, bare, head] = await Promise.all([
		runGit(pi, cwd, ["rev-parse", "--show-toplevel"]),
		runGit(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		runGit(pi, cwd, ["rev-parse", "--is-bare-repository"]),
		runGit(pi, cwd, ["rev-parse", "HEAD"]),
	]);

	for (const result of [checkout, commonDir, bare, head]) {
		if (result.code !== 0) throw gitError(result, "Not inside a Git repository");
	}
	if (bare.stdout.trim() === "true") throw new Error("Bare repositories do not support this worktree workflow");

	return {
		checkoutRoot: checkout.stdout.trim(),
		primaryRoot: primaryRepositoryRoot(commonDir.stdout.trim()),
		head: head.stdout.trim(),
	};
}

async function validateBranch(pi: ExtensionAPI, cwd: string, branch: string): Promise<void> {
	if (!branch) throw new Error("Branch name is required");

	const result = await runGit(pi, cwd, ["check-ref-format", "--branch", branch]);
	if (result.code !== 0) throw new Error(`Invalid branch name: ${branch}`);
}

async function branchExists(pi: ExtensionAPI, cwd: string, branch: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw gitError(result, "Failed to inspect local branches");
}

function canonicalExistingPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

async function registeredWorktreePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await runGit(pi, cwd, ["worktree", "list", "--porcelain", "-z"]);
	if (result.code !== 0) throw gitError(result, "Failed to list Git worktrees");
	return parseWorktreePaths(result.stdout).map(canonicalExistingPath);
}

function hasMaterializedSession(sessionFile: string | undefined): sessionFile is string {
	if (!sessionFile || !existsSync(sessionFile)) return false;

	try {
		return readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } })
			.some((entry) => entry.type === "message" && entry.message?.role === "assistant");
	} catch {
		return false;
	}
}

async function waitForSourceSession(ctx: ExtensionCommandContext): Promise<string> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Waiting for the current agent turn to finish...", "info");
		await ctx.waitForIdle();
	}

	const sourceSession = ctx.sessionManager.getSessionFile();
	if (!hasMaterializedSession(sourceSession)) {
		throw new Error("Worktree handoff requires a saved session with a completed assistant response");
	}
	return sourceSession;
}

async function queueWorktreeHandoff(pi: ExtensionAPI, branch: string): Promise<void> {
	await pi.sendUserMessage(worktreeHandoffCommand(branch), {
		deliverAs: "followUp",
		expandPromptTemplates: true,
	});
}

function wasCompactedWithPiVcc(details: unknown): boolean {
	return typeof details === "object" && details !== null && "compactor" in details && details.compactor === PI_VCC_COMPACTOR;
}

async function switchToSession(ctx: ExtensionCommandContext, sessionFile: string, message: string): Promise<void> {
	const result = await ctx.switchSession(sessionFile, {
		withSession: async (replacementCtx) => {
			replacementCtx.ui.notify(message, "info");
		},
	});
	if (result.cancelled) {
		throw new Error("Worktree session switch was cancelled");
	}
}

async function createAndSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, branch: string): Promise<void> {
	const sourceSession = await waitForSourceSession(ctx);
	const repository = await getRepositoryInfo(pi, ctx.cwd);
	await validateBranch(pi, repository.checkoutRoot, branch);

	const target = worktreeDirectory(repository.primaryRoot, branch);
	if (existsSync(target)) throw new Error(`Worktree path already exists: ${target}`);
	if (await branchExists(pi, repository.checkoutRoot, branch)) throw new Error(`Branch already exists: ${branch}`);

	const addResult = await runGit(pi, repository.checkoutRoot, [
		"worktree",
		"add",
		"-b",
		branch,
		target,
		repository.head,
	]);
	if (addResult.code !== 0) throw gitError(addResult, "Failed to create worktree");

	const targetSession = SessionManager.forkFrom(sourceSession, target).getSessionFile();
	if (!targetSession) throw new Error("Failed to create worktree session");

	await switchToSession(ctx, targetSession, `Switched to worktree: ${target}`);
}

async function switchToWorktree(pi: ExtensionAPI, ctx: ExtensionCommandContext, branch: string): Promise<void> {
	const repository = await getRepositoryInfo(pi, ctx.cwd);
	await validateBranch(pi, repository.checkoutRoot, branch);

	const target = worktreeDirectory(repository.primaryRoot, branch);
	const canonicalTarget = canonicalExistingPath(target);
	const worktrees = await registeredWorktreePaths(pi, repository.checkoutRoot);
	if (!worktrees.includes(canonicalTarget)) throw new Error(`No registered worktree for branch: ${branch}`);

	const sessions = await SessionManager.list(canonicalTarget);
	const latest = sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime())[0];
	if (latest) {
		await switchToSession(ctx, latest.path, `Switched to worktree: ${target}`);
		return;
	}

	const sourceSession = await waitForSourceSession(ctx);
	const targetSession = SessionManager.forkFrom(sourceSession, canonicalTarget).getSessionFile();
	if (!targetSession) throw new Error("Failed to create worktree session");
	await switchToSession(ctx, targetSession, `Switched to worktree: ${target}`);
}

export default function worktreeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "worktree_handoff",
		label: "Worktree Handoff",
		description: "Create a Git worktree and move this Pi conversation into it after user confirmation",
		parameters: WorktreeHandoffParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("worktree_handoff requires interactive confirmation");
			}

			const branch = params.branch.trim();
			const repository = await getRepositoryInfo(pi, ctx.cwd);
			await validateBranch(pi, repository.checkoutRoot, branch);
			const target = worktreeDirectory(repository.primaryRoot, branch);
			const confirmed = await ctx.ui.confirm(
				"Create worktree?",
				worktreeHandoffConfirmation(repository.head, target),
			);
			if (!confirmed) {
				return {
					content: [{ type: "text", text: "Worktree handoff cancelled" }],
					details: { cancelled: true },
				};
			}

			if (params.compact) {
				ctx.compact({
					customInstructions: PI_VCC_COMPACT_INSTRUCTION,
					onComplete: (result) => {
						if (!wasCompactedWithPiVcc(result.details)) {
							ctx.ui.notify("Worktree handoff was not queued: pi-vcc did not compact this session", "error");
							return;
						}
						void queueWorktreeHandoff(pi, branch).catch((error) => {
							ctx.ui.notify(`Worktree handoff was not queued: ${error instanceof Error ? error.message : String(error)}`, "error");
						});
					},
					onError: (error) => {
						ctx.ui.notify(`Worktree handoff was not queued: ${error.message}`, "error");
					},
				});
				return {
					content: [{ type: "text", text: `Compacting with pi-vcc before handing off to ${target}` }],
					details: { branch, target, compacting: true },
				};
			}

			await queueWorktreeHandoff(pi, branch);
			return {
				content: [{ type: "text", text: `Queued worktree handoff to ${target}` }],
				details: { branch, target },
			};
		},
	});

	pi.registerCommand("worktree", {
		description: "Create or switch to a Git worktree",
		handler: async (args, ctx) => {
			try {
				const input = args.trim();
				if (!input) {
					ctx.ui.notify("Usage: /worktree <branch> or /worktree switch <branch>", "error");
					return;
				}

				if (input.startsWith("switch ")) {
					await switchToWorktree(pi, ctx, input.slice("switch ".length).trim());
					return;
				}

				await createAndSwitch(pi, ctx, input);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
