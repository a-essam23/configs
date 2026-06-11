/**
 * Commit extension
 *
 * Adds /commit for committing only staged changes. The extension asks a
 * configured model to generate a commit message from the staged diff plus a
 * compact rolling summary of the current Pi session, then runs git commit
 * itself so the current conversation context is not touched.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface CommitConfig {
	model?: string;
	recentMessages: number;
	maxDiffChars: number;
	maxHistoryChars: number;
	maxSummaryChars: number;
	editMessage: boolean;
	confirm: boolean;
	conventionalCommit: boolean;
}

interface CommitSessionState {
	repoRoot: string;
	sessionId: string;
	lastEntryId?: string;
	summary?: string;
	updatedAt: string;
}

interface CommitStateFile {
	version: 1;
	sessions: Record<string, CommitSessionState>;
}

type CommitModel = NonNullable<ExtensionCommandContext["model"]>;

const DEFAULT_CONFIG: CommitConfig = {
	model: undefined,
	recentMessages: 12,
	maxDiffChars: 90_000,
	maxHistoryChars: 24_000,
	maxSummaryChars: 12_000,
	editMessage: true,
	confirm: false,
	conventionalCommit: true,
};

const SYSTEM_PROMPT = `You generate Git commit messages for staged changes.

Rules:
- Use only the staged diff as the source of truth for what will be committed.
- Use the Pi session history only to understand intent, terminology, and context.
- Do not claim unstaged or unshown changes are included.
- Write a concise imperative subject line, preferably <= 72 characters.
- If conventionalCommit is true, the subject must follow Conventional Commits: type(scope): summary.
- Use a standard type such as feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert.
- Include a short scope when obvious from the staged paths or project area; otherwise omit scope.
- If conventionalCommit is false, use a normal concise imperative subject.
- Add a body only when it helps explain why or groups multiple changes.
- Return strict JSON only, with no Markdown fences or commentary.

JSON shape:
{
  "commitMessage": "subject\\n\\noptional body",
  "historySummary": "rolling summary of the current Pi session useful for future commit messages"
}`;

function getExtensionDir(): string | undefined {
	return typeof __dirname === "string" ? __dirname : undefined;
}

function statePath(): string {
	return join(getAgentDir(), "commit-state.json");
}

function configPaths(): string[] {
	const paths: string[] = [];
	const extensionDir = getExtensionDir();
	if (extensionDir) paths.push(join(extensionDir, "..", "commit.json"));
	paths.push(join(getAgentDir(), "commit.json"));
	return [...new Set(paths)];
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to read ${path}: ${(error as Error).message}`);
	}
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

async function loadConfig(): Promise<CommitConfig> {
	let config: CommitConfig = { ...DEFAULT_CONFIG };
	for (const path of configPaths()) {
		const partial = await readJsonIfExists<Partial<CommitConfig>>(path);
		if (partial) config = { ...config, ...partial };
	}

	return {
		...config,
		recentMessages: numberOrDefault(config.recentMessages, DEFAULT_CONFIG.recentMessages, 0, 100),
		maxDiffChars: numberOrDefault(config.maxDiffChars, DEFAULT_CONFIG.maxDiffChars, 4_000, 500_000),
		maxHistoryChars: numberOrDefault(config.maxHistoryChars, DEFAULT_CONFIG.maxHistoryChars, 2_000, 200_000),
		maxSummaryChars: numberOrDefault(config.maxSummaryChars, DEFAULT_CONFIG.maxSummaryChars, 1_000, 100_000),
		editMessage: config.editMessage !== false,
		confirm: config.confirm === true,
		conventionalCommit: config.conventionalCommit !== false,
	};
}

async function loadState(): Promise<CommitStateFile> {
	try {
		const parsed = JSON.parse(await readFile(statePath(), "utf8")) as CommitStateFile;
		if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object") return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// Bad state should not block committing. Start fresh and overwrite it on save.
		}
	}
	return { version: 1, sessions: {} };
}

async function saveState(state: CommitStateFile): Promise<void> {
	const path = statePath();
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

function sessionIdentity(ctx: ExtensionCommandContext): string {
	const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown-session";
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "in-memory";
	return `${sessionId}\0${sessionFile}`;
}

function stateKey(repoRoot: string, ctx: ExtensionCommandContext): string {
	return createHash("sha256").update(`${repoRoot}\0${sessionIdentity(ctx)}`).digest("hex").slice(0, 24);
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = `\n\n[... truncated ${text.length - maxChars} characters ...]\n\n`;
	const keep = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(keep * 0.65);
	const tail = keep - head;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `[... truncated ${text.length - maxChars} earlier characters ...]\n${text.slice(text.length - maxChars)}`;
}

function stringifyContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const item = block as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") return item.text;
			if (item.type === "thinking") return "[thinking omitted]";
			if (item.type === "image") return "[image]";
			if (item.type === "toolCall") {
				const name = typeof item.name === "string" ? item.name : "tool";
				return `[tool call: ${name} ${JSON.stringify(item.arguments ?? {})}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function serializeEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "message") {
		const message = entry.message as any;
		if (message.role === "user") {
			return `[user]\n${truncateMiddle(stringifyContent(message.content), 4_000)}`;
		}
		if (message.role === "assistant") {
			return `[assistant]\n${truncateMiddle(stringifyContent(message.content), 4_000)}`;
		}
		if (message.role === "toolResult") {
			return `[tool result: ${message.toolName ?? "tool"}${message.isError ? " error" : ""}]\n${truncateMiddle(
				stringifyContent(message.content),
				1_500,
			)}`;
		}
		if (message.role === "bashExecution") {
			return `[user bash]\n$ ${message.command ?? ""}\nexit: ${message.exitCode ?? "unknown"}\n${truncateMiddle(
				message.output ?? "",
				1_500,
			)}`;
		}
		if (message.role === "custom") {
			return `[custom: ${message.customType ?? "custom"}]\n${truncateMiddle(stringifyContent(message.content), 2_000)}`;
		}
	}

	if (entry.type === "compaction") {
		return `[compaction]\n${truncateMiddle(entry.summary, 4_000)}`;
	}

	if (entry.type === "branch_summary") {
		return `[branch summary]\n${truncateMiddle(entry.summary, 4_000)}`;
	}

	return undefined;
}

function serializeEntries(entries: SessionEntry[], maxChars: number): string {
	const serialized = entries.map(serializeEntry).filter((text): text is string => Boolean(text));
	return truncateTail(serialized.join("\n\n---\n\n"), maxChars);
}

function recentInterestingEntries(branch: SessionEntry[], count: number): SessionEntry[] {
	if (count <= 0) return [];
	return branch
		.filter(
			(entry) =>
				entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary",
		)
		.slice(-count);
}

function entriesSinceLastSummary(branch: SessionEntry[], lastEntryId: string | undefined): SessionEntry[] {
	if (!lastEntryId) return branch;
	const index = branch.findIndex((entry) => entry.id === lastEntryId);
	if (index < 0) return branch;
	return branch.slice(index + 1);
}

function resolveConfiguredModel(ctx: ExtensionCommandContext, modelRef: string | undefined): CommitModel | undefined {
	const ref = modelRef?.trim();
	if (!ref) return ctx.model;

	const allModels = ctx.modelRegistry.getAll();
	if (ref.includes("/")) {
		const [provider, ...rest] = ref.split("/");
		const modelId = rest.join("/");
		return (
			ctx.modelRegistry.find(provider, modelId) ??
			allModels.find(
				(model) =>
					model.provider === provider &&
					(model.id === modelId || model.name === modelId || model.id.includes(modelId) || model.name.includes(modelId)),
			)
		);
	}

	const exact = allModels.filter((model) => model.id === ref || model.name === ref);
	if (exact.length === 1) return exact[0];

	const partial = allModels.filter((model) => model.id.includes(ref) || model.name.includes(ref));
	if (partial.length === 1) return partial[0];

	return undefined;
}

async function getRepoRoot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
	if (result.code !== 0) throw new Error("Not inside a git repository");
	return result.stdout.trim();
}

async function getStagedContext(pi: ExtensionAPI, repoRoot: string, config: CommitConfig) {
	const staged = await pi.exec("git", ["diff", "--cached", "--quiet", "--exit-code"], { cwd: repoRoot });
	if (staged.code === 0) return undefined;
	if (staged.code !== 1) throw new Error(staged.stderr.trim() || "Failed to inspect staged changes");

	const [nameStatus, stat, diff] = await Promise.all([
		pi.exec("git", ["diff", "--cached", "--name-status", "--find-renames", "--find-copies"], { cwd: repoRoot }),
		pi.exec("git", ["diff", "--cached", "--stat", "--summary"], { cwd: repoRoot }),
		pi.exec("git", ["diff", "--cached", "--no-ext-diff", "--find-renames", "--find-copies"], { cwd: repoRoot }),
	]);

	for (const result of [nameStatus, stat, diff]) {
		if (result.code !== 0) throw new Error(result.stderr.trim() || "Failed to read staged diff");
	}

	return {
		nameStatus: nameStatus.stdout.trim(),
		stat: stat.stdout.trim(),
		diff: truncateMiddle(diff.stdout, config.maxDiffChars),
		diffWasTruncated: diff.stdout.length > config.maxDiffChars,
	};
}

function buildUserPrompt(input: {
	repoRoot: string;
	staged: NonNullable<Awaited<ReturnType<typeof getStagedContext>>>;
	previousSummary: string;
	newHistory: string;
	recentHistory: string;
	maxSummaryChars: number;
	conventionalCommit: boolean;
}): string {
	return `Repository: ${input.repoRoot}

conventionalCommit: ${input.conventionalCommit ? "true" : "false"}

Previous rolling Pi-session summary:
${input.previousSummary || "[none]"}

New Pi-session history since the previous summary:
${input.newHistory || "[none]"}

Recent Pi-session context:
${input.recentHistory || "[none]"}

Staged files:
${input.staged.nameStatus || "[none]"}

Staged diffstat:
${input.staged.stat || "[none]"}

Staged diff${input.staged.diffWasTruncated ? " (truncated)" : ""}:
${input.staged.diff || "[no textual diff]"}

Return JSON only. Keep historySummary under ${input.maxSummaryChars} characters.`;
}

function stripCodeFence(text: string): string {
	let cleaned = text.trim();
	const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence) cleaned = fence[1].trim();
	return cleaned;
}

function parseModelJson(text: string): { commitMessage?: string; historySummary?: string } {
	const cleaned = stripCodeFence(text);
	try {
		return JSON.parse(cleaned) as { commitMessage?: string; historySummary?: string };
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(cleaned.slice(start, end + 1)) as { commitMessage?: string; historySummary?: string };
			} catch {
				// Fall through to plain-text fallback.
			}
		}
	}
	return { commitMessage: cleaned };
}

function normalizeCommitMessage(message: string): string {
	let normalized = stripCodeFence(message).trim();
	normalized = normalized.replace(/^commit message:\s*/i, "").trim();
	if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
		normalized = normalized.slice(1, -1).trim();
	}
	return normalized
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function responseText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

async function callModel(input: {
	ctx: ExtensionCommandContext;
	model: CommitModel;
	prompt: string;
	signal?: AbortSignal;
}): Promise<{ commitMessage: string; historySummary?: string }> {
	const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${input.model.provider}` : auth.error);
	}

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: input.prompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		input.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal: input.signal },
	);

	if (response.stopReason === "aborted") throw new Error("Commit message generation was cancelled");

	const parsed = parseModelJson(responseText(response));
	const commitMessage = normalizeCommitMessage(parsed.commitMessage ?? "");
	if (!commitMessage) throw new Error("Model returned an empty commit message");

	return {
		commitMessage,
		historySummary: typeof parsed.historySummary === "string" ? parsed.historySummary.trim() : undefined,
	};
}

async function generateCommitMessage(input: {
	ctx: ExtensionCommandContext;
	model: CommitModel;
	prompt: string;
}): Promise<{ commitMessage: string; historySummary?: string }> {
	if (input.ctx.mode !== "tui") {
		return callModel(input);
	}

	const result = await input.ctx.ui.custom<
		| { ok: true; value: { commitMessage: string; historySummary?: string } }
		| { ok: false; error: string }
		| null
	>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating commit message...");
		loader.onAbort = () => done(null);
		callModel({ ...input, signal: loader.signal })
			.then((value) => done({ ok: true, value }))
			.catch((error) => {
				console.error("Commit message generation failed:", error);
				done({ ok: false, error: (error as Error).message });
			});
		return loader;
	});

	if (result === null) throw new Error("Commit message generation was cancelled");
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

async function commitWithMessage(pi: ExtensionAPI, repoRoot: string, message: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-commit-"));
	const messagePath = join(tempDir, "message.txt");
	try {
		await writeFile(messagePath, `${message.trim()}\n`, "utf8");
		const result = await pi.exec("git", ["commit", "-F", messagePath], { cwd: repoRoot });
		if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || "git commit failed");

		const hash = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
		return hash.code === 0 ? hash.stdout.trim() : "";
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Commit staged git changes with an LLM-generated message",
		handler: async (args, ctx) => {
			try {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current agent turn to finish before committing...", "info");
					await ctx.waitForIdle();
				}

				const config = await loadConfig();
				const repoRoot = await getRepoRoot(pi, ctx);
				const staged = await getStagedContext(pi, repoRoot, config);
				if (!staged) {
					ctx.ui.notify("No staged changes to commit", "warning");
					return;
				}

				let commitMessage = normalizeCommitMessage(args.trim());
				const branch = ctx.sessionManager.getBranch();
				const stateFile = await loadState();
				const key = stateKey(repoRoot, ctx);
				const previousState = stateFile.sessions[key];

				if (!commitMessage) {
					const model = resolveConfiguredModel(ctx, config.model);
					if (!model) {
						throw new Error(
							config.model
								? `Commit model not found: ${config.model}`
								: "No model selected and no commit model configured",
						);
					}

					const newHistory = serializeEntries(
						entriesSinceLastSummary(branch, previousState?.lastEntryId),
						config.maxHistoryChars,
					);
					const recentHistory = serializeEntries(recentInterestingEntries(branch, config.recentMessages), config.maxHistoryChars);
					const prompt = buildUserPrompt({
						repoRoot,
						staged,
						previousSummary: truncateMiddle(previousState?.summary ?? "", config.maxSummaryChars),
						newHistory,
						recentHistory,
						maxSummaryChars: config.maxSummaryChars,
						conventionalCommit: config.conventionalCommit,
					});

					const generated = await generateCommitMessage({ ctx, model, prompt });
					commitMessage = generated.commitMessage;

					stateFile.sessions[key] = {
						repoRoot,
						sessionId: sessionIdentity(ctx),
						lastEntryId: ctx.sessionManager.getLeafId() ?? undefined,
						summary: truncateMiddle(generated.historySummary ?? previousState?.summary ?? "", config.maxSummaryChars),
						updatedAt: new Date().toISOString(),
					};
					await saveState(stateFile);
				}

				if (ctx.hasUI && config.editMessage) {
					const edited = await ctx.ui.editor("Edit commit message", commitMessage);
					if (edited === undefined) {
						ctx.ui.notify("Commit cancelled", "info");
						return;
					}
					commitMessage = normalizeCommitMessage(edited);
				}

				if (!commitMessage) throw new Error("Commit message is empty");

				if (ctx.hasUI && config.confirm && !config.editMessage) {
					const confirmed = await ctx.ui.confirm("Commit staged changes?", commitMessage);
					if (!confirmed) {
						ctx.ui.notify("Commit cancelled", "info");
						return;
					}
				}

				const hash = await commitWithMessage(pi, repoRoot, commitMessage);
				const subject = commitMessage.split("\n")[0];
				ctx.ui.notify(`Committed${hash ? ` ${hash}` : ""}: ${subject}`, "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
