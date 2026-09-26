/**
 * OpenCode Free extension for pi.
 *
 * Exposes OpenCode Zen's free models (e.g. big-pickle, *-free) as an
 * `opencode-free` provider, with no API key required.
 *
 * How it works (reverse-engineered from sst/opencode):
 * - packages/opencode/src/provider/provider.ts registers the `opencode`
 *   provider with `apiKey: "public"` when no key is configured, and keeps
 *   only models with `cost.input === 0` (the free tier).
 * - packages/console/app/src/routes/zen/util/handler.ts treats
 *   `Authorization: Bearer public` as anonymous (`allowAnonymous` models)
 *   and rate-limits by IP via the trial limiter.
 * - Anonymous requests must carry opencode client headers, otherwise
 *   Cloudflare/proxying rejects them (HTTP 403/1010 or FreeUsageLimitError).
 *   Since ~2026-09 the Console provider additionally requires a session
 *   header (MissingSessionID otherwise), so a stable per-process
 *   `session_id` is sent with every request.
 *
 * If OPENCODE_API_KEY is set it is used instead of "public" (free models
 * stay free; paid models remain on pi's built-in `opencode` provider).
 *
 * Model metadata below mirrors pi's built-in opencode-go catalog entries
 * for the paid counterparts where one exists. Unknown future `-free`
 * models are picked up dynamically from the live catalog with safe
 * defaults. Fine-tune via ~/.pi/agent/models.json `modelOverrides`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

const PROVIDER_ID = "opencode-free";
const BASE_URL = "https://opencode.ai/zen/v1";
const MODELS_URL = "https://opencode.ai/zen/v1/models";

// Headers that make anonymous Zen requests behave like the opencode CLI.
// Without `x-opencode-client` the gateway answers 403 (Cloudflare 1010)
// or FreeUsageLimitError even when quota remains. `session_id` satisfies
// the free-tier session gate (MissingSessionID otherwise); any stable
// UUID passes, and pi's own per-request session ID overrides it when
// present. One ID per process keeps session-less calls (e.g. automatic
// session titles via completeSimple) working.
const FREE_SESSION_ID: string = randomUUID();

const CLIENT_HEADERS: Record<string, string> = {
	"x-opencode-client": "opencode",
	"user-agent": "opencode/1.18.29",
	"session_id": FREE_SESSION_ID,
};

type FreeModelMeta = {
	id: string;
	name: string;
	api: "openai-completions" | "openai-responses";
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
};

// Static metadata for the known free tier (2026-09). Values mirror pi's
// built-in opencode-go catalog for the paid counterparts where available.
const KNOWN_FREE_MODELS: FreeModelMeta[] = [
	{
		id: "big-pickle",
		name: "Big Pickle (free)",
		api: "openai-completions",
		contextWindow: 131072,
		maxTokens: 32768,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash (free)",
		api: "openai-completions",
		contextWindow: 1000000,
		maxTokens: 384000,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		},
		thinkingLevelMap: { minimal: null, medium: null, xhigh: null },
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo V2.5 (free)",
		api: "openai-completions",
		contextWindow: 1000000,
		maxTokens: 128000,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "ling-3.0-flash-fin-free",
		name: "Ling 3.0 Flash Fin (free)",
		api: "openai-completions",
		contextWindow: 131072,
		maxTokens: 32768,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra (free)",
		api: "openai-completions",
		contextWindow: 262144,
		maxTokens: 131072,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning (free)",
		api: "openai-completions",
		contextWindow: 262144,
		maxTokens: 131072,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "muse-spark-1.2-contributor-free",
		name: "Muse Spark 1.2 Contributor (free)",
		api: "openai-responses",
		contextWindow: 1048576,
		maxTokens: 131072,
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	},
	{
		id: "muse-spark-1.3-contributor-free",
		name: "Muse Spark 1.3 Contributor (free)",
		api: "openai-responses",
		contextWindow: 1048576,
		maxTokens: 131072,
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	},
];

function prettify(id: string): string {
	return (
		id
			.replace(/-free$/, " (free)")
			.split("-")
			.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
			.join(" ")
	);
}

async function fetchLiveFreeIds(): Promise<string[] | undefined> {
	try {
		const res = await fetch(MODELS_URL, {
			headers: { ...CLIENT_HEADERS },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) return undefined;
		const payload = (await res.json()) as {
			data?: Array<{ id?: string }>;
		};
		const ids = (payload.data ?? [])
			.map((m) => m.id ?? "")
			.filter((id) => id === "big-pickle" || id.endsWith("-free"));
		return ids;
	} catch {
		return undefined;
	}
}

export default async function (pi: ExtensionAPI) {
	const knownById = new Map(KNOWN_FREE_MODELS.map((m) => [m.id, m]));
	const liveIds = await fetchLiveFreeIds();

	// Prefer the live catalog (new free models appear/disappear regularly),
	// fall back to the static list when offline.
	const metas: FreeModelMeta[] = liveIds
		? liveIds.map(
				(id): FreeModelMeta =>
					knownById.get(id) ?? {
						id,
						name: prettify(id),
						api: "openai-completions",
						contextWindow: 131072,
						maxTokens: 32768,
						input: ["text"],
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							maxTokensField: "max_tokens",
						},
					},
			)
		: [...knownById.values()];

	const apiKey = process.env.OPENCODE_API_KEY?.trim() || "public";

	pi.registerProvider(PROVIDER_ID, {
		name: "OpenCode Free",
		baseUrl: BASE_URL,
		apiKey,
		api: "openai-completions",
		headers: { ...CLIENT_HEADERS },
		models: metas.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: true,
			input: m.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.compat ? { compat: m.compat } : {}),
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
		})),
	});
}
