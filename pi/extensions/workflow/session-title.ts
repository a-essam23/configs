/**
 * Session title extension
 *
 * Generates a concise title from the first user message and assigns it to the
 * session without interrupting the active conversation.
 *
 * Config (`configs/session-title.json`):
 *   {
 *     "model": "provider/model-id",
 *     "thinking": false
 *   }
 *
 * If `model` is omitted, the active session model is used.
 */

import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// Types and defaults
// ============================================================================

type SessionTitleModel = NonNullable<ExtensionContext["model"]>;

interface SessionTitleConfig {
  model?: string;
  thinking?: ThinkingLevel | false;
}

const DEFAULT_CONFIG: SessionTitleConfig = {
  model: undefined,
  thinking: false,
};

const SYSTEM_PROMPT = `You generate concise titles for coding-agent sessions.

Rules:
- Summarize the user's request, not a response to it.
- Return only the title, with no quotes, Markdown, or explanation.
- Use 3 to 8 words when possible.
- Keep it under 80 characters.
- Do not end with punctuation.`;

// ============================================================================
// Configuration and model resolution
// ============================================================================

function configPaths(): string[] {
  const paths: string[] = [];
  if (typeof __dirname === "string") {
    paths.push(join(__dirname, "..", "configs", "session-title.json"));
  }
  paths.push(join(getAgentDir(), "configs", "session-title.json"));
  return [...new Set(paths)];
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Failed to read ${filePath}: ${(error as Error).message}`);
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

async function loadConfig(): Promise<SessionTitleConfig> {
  let config: SessionTitleConfig = { ...DEFAULT_CONFIG };
  for (const filePath of configPaths()) {
    const partial = await readJsonIfExists<Partial<SessionTitleConfig>>(filePath);
    if (partial) config = { ...config, ...partial };
  }

  return {
    model: typeof config.model === "string" ? config.model : undefined,
    thinking: config.thinking === false || isThinkingLevel(config.thinking) ? config.thinking : DEFAULT_CONFIG.thinking,
  };
}

function resolveConfiguredModel(ctx: ExtensionContext, modelRef: string | undefined): SessionTitleModel | undefined {
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
  return partial.length === 1 ? partial[0] : undefined;
}

// ============================================================================
// Title generation
// ============================================================================

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeTitle(rawTitle: string): string {
  let title = rawTitle.trim();
  title = title.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  title = title.replace(/^title\s*:\s*/i, "").trim();
  title = title.replace(/^(["'])(.*)\1$/, "$2").trim();
  title = title.replace(/\s+/g, " ").replace(/[.!?:;,]+$/, "").trim();
  return title.slice(0, 80).trim();
}

async function generateTitle(input: {
  ctx: ExtensionContext;
  model: SessionTitleModel;
  prompt: string;
  thinking?: ThinkingLevel;
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
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      ...(input.thinking ? { reasoning: input.thinking } : {}),
    },
  );

  if (response.stopReason === "aborted") throw new Error("Title generation was cancelled");
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Title generation failed");

  const rawTitle = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  const title = normalizeTitle(rawTitle);
  if (!title) throw new Error("Model returned an empty title");
  return title;
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function sessionTitleExtension(pi: ExtensionAPI): void {
  let titleAttempted = false;
  let sessionGeneration = 0;

  pi.on("session_start", (_event, ctx) => {
    sessionGeneration++;
    const hasExistingTitle = Boolean(pi.getSessionName());
    const hasExistingUserMessage = ctx.sessionManager.getBranch().some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    titleAttempted = hasExistingTitle || hasExistingUserMessage;
  });

  pi.on("session_shutdown", () => {
    sessionGeneration++;
  });

  pi.on("message_end", (event, ctx) => {
    if (titleAttempted || event.message.role !== "user") return;

    const prompt = messageText(event.message);
    if (!prompt) return;

    // Mark this before starting the asynchronous request so multiple message
    // events cannot launch competing title generations.
    titleAttempted = true;
    const generation = sessionGeneration;
    const canNotify = ctx.hasUI;

    void (async () => {
      try {
        const config = await loadConfig();
        const model = resolveConfiguredModel(ctx, config.model);
        if (!model) {
          throw new Error(
            config.model
              ? `Session title model not found: ${config.model}`
              : "No active model available for session title",
          );
        }

        const title = await generateTitle({
          ctx,
          model,
          prompt,
          thinking: config.thinking === false ? undefined : config.thinking,
        });

        // Ignore a result from a session that was replaced while generating.
        if (generation !== sessionGeneration) return;

        // Do not replace a name set while the title request was running.
        if (!pi.getSessionName()) pi.setSessionName(title);
      } catch (error) {
        if (generation === sessionGeneration && canNotify) {
          ctx.ui.notify(`Automatic session title failed: ${(error as Error).message}`, "warning");
        }
      }
    })();
  });
}
