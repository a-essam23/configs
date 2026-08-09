/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * Omit the goal to continue from the current conversation.
 *
 * Config (`configs/handoff.json`, same lookup pattern as `configs/commit.json`):
 *   {
 *     "model": "anthropic/claude-sonnet-4-5",
 *     "thinking": false,
 *     "mode": "draft",
 *     "memories": "propose"
 *   }
 *
 * Modes:
 *   draft - create a new session and put the generated prompt in the editor
 *   auto  - create a new session and immediately submit the generated prompt
 *
 * Memory modes:
 *   off     - do not evaluate memory candidates
 *   propose - propose durable memory candidates in a selectable review UI before opening the new session
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	convertToLlm,
	getAgentDir,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// TYPES
// ============================================================================

const HANDOFF_MODES = ["draft", "auto"] as const;
type HandoffMode = (typeof HANDOFF_MODES)[number];

const MEMORY_MODES = ["off", "propose"] as const;
type MemoryMode = (typeof MEMORY_MODES)[number];

type HandoffModel = NonNullable<ExtensionCommandContext["model"]>;

interface HandoffConfig {
	model?: string;
	thinking?: ThinkingLevel | false;
	mode: HandoffMode;
	memories: MemoryMode;
}

interface MemoryRecord {
	id: string;
	content: string;
	key?: string;
	type: "core" | "regular";
	timestamp: string;
}

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_CONFIG: HandoffConfig = {
	model: undefined,
	thinking: false,
	mode: "draft",
	memories: "propose",
};

const DEFAULT_GOAL =
	"Continue from the current conversation in a new focused session. Infer the next sensible task from the latest discussion and preserve all context needed to proceed.";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant session-local context from the conversation (decisions made, approaches taken, key findings)
2. Lists relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained — the new thread should be able to proceed without the old conversation
5. Uses imperative, directive language — no first person (no "I", "we", "me", "us", "my", "our"). Address the agent directly.
6. Does not duplicate durable preferences or project conventions that belong in memories. Instead, tell the new agent to check relevant memories before acting.
7. Defaults to review/confirmation before implementation unless the user's goal explicitly asks for execution.

Format your response as a prompt that will be the first instruction to a new agent session. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" — just output the prompt itself.

Example output format:
## Context
Working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear, imperative description of what the agent should do next based on the user's goal]

## First Step
Check relevant memories for this project before acting. Summarize understanding and ask for confirmation before implementation unless the task explicitly requires immediate execution.`;

// ============================================================================
// CONFIG & PATHS
// ============================================================================

function getExtensionDir(): string | undefined {
	return typeof __dirname === "string" ? __dirname : undefined;
}

function configPaths(): string[] {
	const paths: string[] = [];
	const extensionDir = getExtensionDir();
	if (extensionDir) paths.push(join(extensionDir, "..", "configs", "handoff.json"));
	paths.push(join(getAgentDir(), "configs", "handoff.json"));
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

function isHandoffMode(value: unknown): value is HandoffMode {
	return HANDOFF_MODES.includes(value as HandoffMode);
}

function isMemoryMode(value: unknown): value is MemoryMode {
	return MEMORY_MODES.includes(value as MemoryMode);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

async function loadConfig(): Promise<HandoffConfig> {
	let config: HandoffConfig = { ...DEFAULT_CONFIG };
	for (const path of configPaths()) {
		const partial = await readJsonIfExists<Partial<HandoffConfig>>(path);
		if (partial) config = { ...config, ...partial };
	}

	return {
		...config,
		mode: isHandoffMode(config.mode) ? config.mode : DEFAULT_CONFIG.mode,
		memories: isMemoryMode(config.memories) ? config.memories : DEFAULT_CONFIG.memories,
		thinking: config.thinking === false || isThinkingLevel(config.thinking) ? config.thinking : DEFAULT_CONFIG.thinking,
	};
}

// ============================================================================
// MODEL HELPERS
// ============================================================================

function resolveConfiguredModel(ctx: ExtensionCommandContext, modelRef: string | undefined): HandoffModel | undefined {
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

function responseText(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

async function generateHandoffPrompt(input: {
	ctx: ExtensionCommandContext;
	model: HandoffModel;
	conversationText: string;
	goal: string;
	existingMemories: MemoryRecord[];
	sourceSessionFile?: string;
	signal?: AbortSignal;
	reasoning?: ThinkingLevel;
}): Promise<string | null> {
	const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${input.model.provider}` : auth.error);
	}

	const existing = input.existingMemories
		.map((memory) => `- [${memory.id.startsWith("global:") ? "global" : "local"}/${memory.type}] ${memory.key ?? ""}: ${memory.content}`)
		.join("\n");
	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Source Session\n\n${input.sourceSessionFile ?? "(unknown)"}\n\n## Existing Memories\n\n${existing || "(none)"}\n\nDo not duplicate these existing memories in the handoff prompt. Only include session-specific constraints that are not already captured by memory.\n\n## Conversation History\n\n${input.conversationText}\n\n## User's Goal for New Thread\n\n${input.goal}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await completeSimple(
		input.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: input.signal,
			...(input.reasoning ? { reasoning: input.reasoning } : {}),
		},
	);

	if (response.stopReason === "aborted") return null;
	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Handoff generation failed");

	const prompt = responseText(response);
	if (!prompt) throw new Error("Model returned an empty handoff prompt");
	return prompt;
}

async function generateWithLoader<T>(
	ctx: ExtensionCommandContext,
	label: string,
	fn: (signal: AbortSignal) => Promise<T | null>,
): Promise<T | null> {
	const result = await ctx.ui.custom<
		| { ok: true; value: T }
		| { ok: false; error: string }
		| null
	>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `${label}...`);
		loader.onAbort = () => done(null);

		fn(loader.signal)
			.then((value) => done(value === null ? null : { ok: true, value }))
			.catch((error) => {
				console.error(`${label} failed:`, error);
				done({ ok: false, error: (error as Error).message });
			});

		return loader;
	});

	if (result === null) return null;
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

// ============================================================================
// MEMORY HELPERS
// ============================================================================

async function requestMemories<T>(
	pi: ExtensionAPI,
	action: string,
	payload: Record<string, unknown>,
	timeoutMs = 2000,
): Promise<T> {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return await new Promise<T>((resolve, reject) => {
		let off: (() => void) | undefined;
		const timeout = setTimeout(() => {
			off?.();
			reject(new Error("memories extension service unavailable"));
		}, timeoutMs);

		off = pi.events.on(`memories:response:${id}`, (raw) => {
			clearTimeout(timeout);
			off?.();
			const response = raw as { ok?: boolean; error?: string } & T;
			if (response.ok === false) {
				reject(new Error(response.error ?? "memories extension request failed"));
				return;
			}
			resolve(response as T);
		});

		pi.events.emit("memories:request:v2", { id, action, ...payload });
	});
}

async function listExistingMemories(pi: ExtensionAPI, cwd: string): Promise<MemoryRecord[]> {
	const response = await requestMemories<{ memories: MemoryRecord[] }>(pi, "list", { cwd });
	return response.memories ?? [];
}

async function scanTextForMemories(input: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	model: HandoffModel;
	conversationText: string;
	reasoning?: ThinkingLevel;
}): Promise<{ savedCount: number; candidateCount: number; cancelled?: boolean }> {
	const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${input.model.provider}` : auth.error);
	}

	return await requestMemories<{ savedCount: number; candidateCount: number; cancelled?: boolean }>(input.pi, "scan-text", {
		cwd: input.ctx.cwd,
		conversationText: input.conversationText,
		model: input.model,
		apiKey: auth.apiKey,
		headers: auth.headers,
		reasoning: input.reasoning,
	}, 120000);
}

function appendMemoryNotice(prompt: string, savedCount: number): string {
	if (savedCount === 0) return prompt;
	const noun = savedCount === 1 ? "memory was" : "memories were";
	return `${prompt.trim()}\n\n## Memory Note\n${savedCount} new ${noun} saved from the previous session. Check relevant memories before acting.`;
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			try {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("handoff requires interactive mode", "error");
					return;
				}

				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current agent turn to finish before handing off...", "info");
					await ctx.waitForIdle();
				}

				const goal = args.trim() || DEFAULT_GOAL;

				const config = await loadConfig();
				const model = resolveConfiguredModel(ctx, config.model);
				if (!model) {
					throw new Error(
						config.model ? `Handoff model not found: ${config.model}` : "No model selected and no handoff model configured",
					);
				}

				// Gather conversation context from current branch. If the branch was compacted,
				// include the compaction summary plus entries from firstKeptEntryId onward.
				const messages = getHandoffMessages(ctx.sessionManager.getBranch());

				if (messages.length === 0) {
					ctx.ui.notify("No conversation to hand off", "error");
					return;
				}

				// Convert to LLM format and serialize.
				const llmMessages = convertToLlm(messages);
				const conversationText = serializeConversation(llmMessages);
				const currentSessionFile = ctx.sessionManager.getSessionFile();
				let memoryServiceAvailable = true;
				let existingMemories: MemoryRecord[] = [];
				try {
					existingMemories = await listExistingMemories(pi, ctx.cwd);
				} catch {
					memoryServiceAvailable = false;
				}

				const handoffPrompt = await generateWithLoader(ctx, "Generating handoff prompt", (signal) =>
					generateHandoffPrompt({
						ctx,
						model,
						conversationText,
						goal,
						existingMemories,
						sourceSessionFile: currentSessionFile,
						signal,
						reasoning: config.thinking === false ? undefined : config.thinking,
					}),
				);

				if (handoffPrompt === null) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}

				let savedMemoryCount = 0;
				if (config.memories === "propose" && memoryServiceAvailable) {
					const result = await scanTextForMemories({
						pi,
						ctx,
						model,
						conversationText,
						reasoning: config.thinking === false ? undefined : config.thinking,
					});

					if (result.cancelled) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					savedMemoryCount = result.savedCount;
					if (savedMemoryCount > 0) {
						ctx.ui.notify(`Saved ${savedMemoryCount} handoff memor${savedMemoryCount === 1 ? "y" : "ies"}`, "info");
					}
				}

				const finalHandoffPrompt = appendMemoryNotice(handoffPrompt, savedMemoryCount);

				// Create new session with parent tracking. Use the replacement-session
				// context for post-switch UI work; the original ctx is stale after a
				// successful session replacement.
				const newSessionResult = await ctx.newSession({
					parentSession: currentSessionFile,
					withSession: async (replacementCtx) => {
						try {
							if (config.mode === "auto") {
								replacementCtx.ui.notify("Handoff starting...", "info");
								await replacementCtx.sendUserMessage(finalHandoffPrompt);
								return;
							}

							replacementCtx.ui.setEditorText(finalHandoffPrompt);
							replacementCtx.ui.notify("Handoff draft ready. Submit when ready.", "info");
						} catch (error) {
							replacementCtx.ui.notify((error as Error).message, "error");
						}
					},
				});

				if (newSessionResult.cancelled) {
					ctx.ui.notify("New session cancelled", "info");
				}
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
