/**
 * Commit extension
 *
 * Adds /commit for committing only staged changes. The extension asks a
 * configured model to generate a commit message from the staged diff,
 * then runs git commit itself so the current conversation context is not touched.
 *
 * Commands:
 *   /commit [message]    Commit staged changes (generates message if omitted)
 *   /commit-pattern      Generate or edit the commit message pattern saved in config
 */

import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ============================================================================
// TYPES
// ============================================================================

interface CommitConfig {
	model?: string;
	thinking?: ThinkingLevel | false;
	commitPattern?: string;
	maxDiffChars: number;
	editMessage: boolean;
	confirm: boolean;
	conventionalCommit: boolean;
}

type CommitModel = NonNullable<ExtensionCommandContext["model"]>;

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_COMMIT_PATTERN = [
	"Write a concise imperative subject line, preferably <= 72 characters.",
	"If conventionalCommit is true, the subject must follow Conventional Commits: type(scope): summary.",
	"Use a standard type such as feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert.",
	"Include a short scope when obvious from the staged paths or project area; otherwise omit scope.",
	"If conventionalCommit is false, use a normal concise imperative subject.",
	"Add a body only when it helps explain why or groups multiple changes.",
].join("\n");

const DEFAULT_CONFIG: CommitConfig = {
	model: undefined,
	thinking: false,
	commitPattern: undefined,
	maxDiffChars: 90_000,
	editMessage: true,
	confirm: false,
	conventionalCommit: true,
};

function buildSystemPrompt(pattern: string): string {
	return `You generate Git commit messages for staged changes.

Rules:
- Use only the staged diff as the source of truth for what will be committed.
- Do not claim unstaged or unshown changes are included.
- Return strict JSON only, with no Markdown fences or commentary.

JSON shape:
{
  "commitMessage": "subject\\n\\noptional body"
}

Commit message style:
${pattern}`;
}

const PATTERN_SYSTEM_PROMPT = `You generate commit message style patterns for a git commit message generator. The pattern will be injected into a system prompt each time a commit message is generated from a git diff.

Return plain text only — no JSON, no Markdown fences, no commentary. Be thorough but concise.`;

const PATTERN_USER_PROMPT = `Generate a commit message style guide / pattern. Describe:

- Subject line format and length conventions
- When to add a body vs just a subject line
- Any special formatting rules or conventions

Return only the pattern text.`;

// ============================================================================
// CONFIG & PATHS
// ============================================================================

function getExtensionDir(): string | undefined {
	return typeof __dirname === "string" ? __dirname : undefined;
}

function configPaths(): string[] {
	const paths: string[] = [];
	const extensionDir = getExtensionDir();
	if (extensionDir) paths.push(join(extensionDir, "..", "configs", "commit.json"));
	paths.push(join(getAgentDir(), "configs", "commit.json"));
	return [...new Set(paths)];
}

/** Returns the first existing config path, or the first path if none exist. */
function existingConfigPath(): string {
	const paths = configPaths();
	for (const p of paths) {
		if (existsSync(p)) return p;
	}
	return paths[0];
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to read ${path}: ${(error as Error).message}`);
	}
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
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
		maxDiffChars: numberOrDefault(config.maxDiffChars, DEFAULT_CONFIG.maxDiffChars, 4_000, 500_000),
		editMessage: config.editMessage !== false,
		confirm: config.confirm === true,
		conventionalCommit: config.conventionalCommit !== false,
	};
}

// ============================================================================
// GIT HELPERS
// ============================================================================

async function getRepoRoot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
	if (result.code !== 0) throw new Error("Not inside a git repository");
	return result.stdout.trim();
}

async function getStagedContext(pi: ExtensionAPI, repoRoot: string, maxDiffChars: number) {
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
		diff: truncateMiddle(diff.stdout, maxDiffChars),
		diffWasTruncated: diff.stdout.length > maxDiffChars,
	};
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

// ============================================================================
// TEXT HELPERS
// ============================================================================

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = `\n\n[... truncated ${text.length - maxChars} characters ...]\n\n`;
	const keep = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(keep * 0.65);
	const tail = keep - head;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function stripCodeFence(text: string): string {
	let cleaned = text.trim();
	const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence) cleaned = fence[1].trim();
	return cleaned;
}

function parseModelJson(text: string): { commitMessage?: string } {
	const cleaned = stripCodeFence(text);
	try {
		return JSON.parse(cleaned) as { commitMessage?: string };
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(cleaned.slice(start, end + 1)) as { commitMessage?: string };
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

function responseText(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

// ============================================================================
// PROMPT BUILDING
// ============================================================================

function buildDiffPrompt(input: {
	repoRoot: string;
	staged: NonNullable<Awaited<ReturnType<typeof getStagedContext>>>;
	conventionalCommit: boolean;
}): string {
	return `Repository: ${input.repoRoot}

conventionalCommit: ${input.conventionalCommit ? "true" : "false"}

Staged files:
${input.staged.nameStatus || "[none]"}

Staged diffstat:
${input.staged.stat || "[none]"}

Staged diff${input.staged.diffWasTruncated ? " (truncated)" : ""}:
${input.staged.diff || "[no textual diff]"}

Return JSON only.`;
}

// ============================================================================
// MODEL CALLS
// ============================================================================

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

async function callModel(input: {
	ctx: ExtensionCommandContext;
	model: CommitModel;
	systemPrompt: string;
	prompt: string;
	signal?: AbortSignal;
	reasoning?: ThinkingLevel;
}): Promise<string> {
	const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${input.model.provider}` : auth.error);
	}

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: input.prompt }],
		timestamp: Date.now(),
	};

	const response = await completeSimple(
		input.model,
		{ systemPrompt: input.systemPrompt, messages: [userMessage] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: input.signal,
			...(input.reasoning ? { reasoning: input.reasoning } : {}),
		},
	);

	if (response.stopReason === "aborted") throw new Error("Commit message generation was cancelled");

	return responseText(response);
}

async function generateWithLoader<T>(
	ctx: ExtensionCommandContext,
	label: string,
	fn: (signal: AbortSignal) => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
): Promise<T> {
	if (ctx.mode !== "tui") {
		const result = await fn(new AbortController().signal);
		if (!result.ok) throw new Error(result.error);
		return result.value;
	}

	const uiResult = await ctx.ui.custom<
		| { ok: true; value: T }
		| { ok: false; error: string }
		| null
	>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `${label}...`);
		loader.onAbort = () => done(null);
		fn(loader.signal)
			.then((value) => done(value))
			.catch((error) => {
				console.error(`${label} failed:`, error);
				done({ ok: false, error: (error as Error).message });
			});
		return loader;
	});

	if (uiResult === null) throw new Error(`${label} was cancelled`);
	if (!uiResult.ok) throw new Error(uiResult.error);
	return uiResult.value;
}

// ============================================================================
// COMMANDS
// ============================================================================

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
				const staged = await getStagedContext(pi, repoRoot, config.maxDiffChars);
				if (!staged) {
					ctx.ui.notify("No staged changes to commit", "warning");
					return;
				}

				let commitMessage = normalizeCommitMessage(args.trim());

				if (!commitMessage) {
					const model = resolveConfiguredModel(ctx, config.model);
					if (!model) {
						throw new Error(
							config.model
								? `Commit model not found: ${config.model}`
								: "No model selected and no commit model configured",
						);
					}

					const systemPrompt = buildSystemPrompt(config.commitPattern ?? DEFAULT_COMMIT_PATTERN);
					const prompt = buildDiffPrompt({ repoRoot, staged, conventionalCommit: config.conventionalCommit });

					const generated = await generateWithLoader(ctx, "Generating commit message", async (signal) => {
						const raw = await callModel({
							ctx,
							model,
							systemPrompt,
							prompt,
							signal,
							reasoning: config.thinking === false ? undefined : config.thinking,
						});
						const parsed = parseModelJson(raw);
						const msg = normalizeCommitMessage(parsed.commitMessage ?? "");
						if (!msg) return { ok: false, error: "Model returned an empty commit message" };
						return { ok: true, value: msg };
					});

					commitMessage = generated;
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

	pi.registerCommand("commit-pattern", {
		description: "Generate or edit the commit message style pattern used by /commit",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current agent turn to finish...", "info");
					await ctx.waitForIdle();
				}

				const config = await loadConfig();
				const model = resolveConfiguredModel(ctx, config.model);
				if (!model) {
					throw new Error(
						config.model
							? `Commit model not found: ${config.model}`
							: "No model selected and no commit model configured",
					);
				}

				// Generate a pattern suggestion
				const suggested = await generateWithLoader(ctx, "Generating commit pattern", async (signal) => {
					const raw = await callModel({
						ctx,
						model,
						systemPrompt: PATTERN_SYSTEM_PROMPT,
						prompt: PATTERN_USER_PROMPT,
						signal,
						reasoning: config.thinking === false ? undefined : config.thinking,
					});
					const cleaned = stripCodeFence(raw).trim();
					if (!cleaned) return { ok: false, error: "Model returned an empty pattern" };
					return { ok: true, value: cleaned };
				});

				// Let user edit
				const edited = await ctx.ui.editor("Edit commit pattern", suggested);
				if (edited === undefined) {
					ctx.ui.notify("Pattern update cancelled", "info");
					return;
				}
				const finalPattern = edited.trim();
				if (!finalPattern) {
					ctx.ui.notify("Pattern update cancelled (empty)", "warning");
					return;
				}

				// Save to existing config file, preserving other fields
				const configPath = existingConfigPath();
				const existing = await readJsonIfExists<Record<string, unknown>>(configPath);
				const updated = { ...(existing ?? {}), commitPattern: finalPattern };
				await writeJsonFile(configPath, updated);
				ctx.ui.notify("Commit pattern saved", "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
