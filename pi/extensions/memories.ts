/**
 * Memories Extension
 *
 * Persistent, cross-session memory system for pi. The LLM proactively saves
 * concise notes about user preferences, project conventions, and personal
 * facts. Core memories are auto-injected into the system prompt on every turn.
 *
 * Memory model:
 *   type:  "core" (always loaded) | "regular" (on-demand recall)
 *   scope: "global" (all projects) | "local" (this project only)
 *
 * Storage:
 *   global -> ~/.pi/agent/memories.json
 *   local  -> <cwd>/.pi/memories.json
 *
 * Tools:     save_memory, recall_memories, delete_memory, update_memory
 * Commands:  /memories (view all), /memory add (quick add)
 * Widget:    Shows live memory counts below the editor
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { matchesKey, Text, truncateToWidth, type Theme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface Memory {
  id: string; // "global:<uuid>" | "local:<uuid>"
  content: string;
  key?: string;
  type: "core" | "regular";
  timestamp: string;
}

type MemoryScope = "global" | "local";

// ═══════════════════════════════════════════════════════════════════════════════
// Storage
// ═══════════════════════════════════════════════════════════════════════════════

const GLOBAL_FILE = path.join(os.homedir(), ".pi", "agent", "memories.json");

function localFile(cwd: string): string {
  return path.join(cwd, ".pi", "memories.json");
}

function loadMemories(filePath: string): Memory[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw as Memory[];
  } catch {
    return [];
  }
}

function saveMemories(filePath: string, memories: Memory[]): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(memories, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal — memory persistence is best-effort
    console.error("[memories] Failed to save:", err);
  }
}

function makeId(scope: MemoryScope): string {
  return `${scope}:${randomUUID()}`;
}

function parseId(id: string): { scope: MemoryScope; uuid: string } | null {
  const m = id.match(/^(global|local):(.+)$/);
  if (!m) return null;
  return { scope: m[1] as MemoryScope, uuid: m[2] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// In-memory cache & session state
// ═══════════════════════════════════════════════════════════════════════════════

let globalMemories: Memory[] = [];
let localMemories: Memory[] = [];
let sessionNewCount = 0; // memories added this session
let currentCtx: ExtensionContext | null = null;

function reloadAll(cwd: string): void {
  globalMemories = loadMemories(GLOBAL_FILE);
  localMemories = loadMemories(localFile(cwd));
}

function allMemories(): Memory[] {
  return [...globalMemories, ...localMemories];
}

function coreMemories(): Memory[] {
  return allMemories().filter((m) => m.type === "core");
}

function stats() {
  const all = allMemories();
  const core = all.filter((m) => m.type === "core").length;
  const regular = all.filter((m) => m.type === "regular").length;
  const global_ = all.filter((m) => m.id.startsWith("global:")).length;
  const local_ = all.filter((m) => m.id.startsWith("local:")).length;
  return { core, regular, global: global_, local: local_, total: all.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Widget
// ═══════════════════════════════════════════════════════════════════════════════

function renderStatus(theme: Theme, newCount: number): string {
  const s = stats();
  const parts: string[] = [];

  if (s.core > 0) parts.push(theme.fg("accent", `${s.core} core`));
  if (s.regular > 0) parts.push(theme.fg("muted", `${s.regular} regular`));
  if (s.total === 0) return "";

  let line = theme.fg("dim", "[MEMORIES]") + " " + parts.join(" · ");

  if (newCount > 0) {
    line += "  " + theme.fg("muted", `+${newCount}`);
  }

  return line;
}

function refreshStatus(): void {
  if (!currentCtx || !currentCtx.hasUI) return;
  const text = renderStatus(currentCtx.ui.theme, sessionNewCount);
  currentCtx.ui.setStatus("memories", text || undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════
// System prompt injection
// ═══════════════════════════════════════════════════════════════════════════════

function buildMemoriesSection(): string {
  const all = allMemories();
  if (all.length === 0) return "";

  const cores = all.filter((m) => m.type === "core");
  const lines: string[] = [];
  lines.push("## Memories");

  // Core memories in full
  for (const m of cores) {
    lines.push(`- ${m.content}`);
  }

  if (cores.length > 0 && all.length > cores.length) {
    lines.push("");
  }

  // Compact index of all memory keys (for awareness + duplicate prevention)
  const keys = [...new Set(all.map((m) => m.key).filter(Boolean))];
  if (keys.length > 0) {
    lines.push(`Saved memory keys: ${keys.join(", ")}`);
  }
  lines.push("Use recall_memories to search, or call with no query to list all. Check before saving to avoid duplicates.");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool schemas
// ═══════════════════════════════════════════════════════════════════════════════

const SaveParams = Type.Object({
  content: Type.String({
    description:
      "The memory to save. Must be extremely concise — one short sentence.",
  }),
  key: Type.Optional(
    Type.String({
      description:
        "Category key (e.g. 'coding-style', 'tools', 'personal', 'project-convention')",
    }),
  ),
  type: Type.Optional(
    StringEnum(["core", "regular"] as const, {
      description:
        "core = always loaded into system prompt. regular = only on recall. Default: regular.",
    }),
  ),
  scope: Type.Optional(
    StringEnum(["global", "local"] as const, {
      description:
        "global = applies everywhere. local = this project only. Default: local.",
    }),
  ),
});

const RecallParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Search term — tokens are fuzzy-matched against content and key",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "Filter by exact key/category",
    }),
  ),
  scope: Type.Optional(
    StringEnum(["global", "local", "both"] as const, {
      description: "Which scopes to search. Default: both.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results to return. Default: 10.",
    }),
  ),
});

const DeleteParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Memory ID to delete (e.g. 'global:abc123')",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "Delete by key/category instead of ID. Deletes all matching.",
    }),
  ),
  scope: Type.Optional(
    StringEnum(["global", "local", "both"] as const, {
      description:
        "Which scope to search when deleting by key. Default: both.",
    }),
  ),
});

const UpdateParams = Type.Object({
  id: Type.String({
    description: "Memory ID to update",
  }),
  content: Type.Optional(
    Type.String({
      description: "New content",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "New key/category",
    }),
  ),
  type: Type.Optional(
    StringEnum(["core", "regular"] as const, {
      description: "New type",
    }),
  ),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TUI component for /memories
// ═══════════════════════════════════════════════════════════════════════════════

class MemoriesList {
  private memories: Memory[];
  private theme: Theme;
  private onClose: () => void;

  constructor(memories: Memory[], theme: Theme, onClose: () => void) {
    this.memories = memories;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    lines.push("");
    const title = th.fg("accent", " Memories ");
    const header =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 13)));
    lines.push(truncateToWidth(header, width));
    lines.push("");

    if (this.memories.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No memories yet. The agent will save them as you work.")}`,
          width,
        ),
      );
    }

    // Group by scope, then type
    const globalCores = this.memories.filter(
      (m) => m.id.startsWith("global:") && m.type === "core",
    );
    const globalRegular = this.memories.filter(
      (m) => m.id.startsWith("global:") && m.type === "regular",
    );
    const localCores = this.memories.filter(
      (m) => m.id.startsWith("local:") && m.type === "core",
    );
    const localRegular = this.memories.filter(
      (m) => m.id.startsWith("local:") && m.type === "regular",
    );

    const groups: Array<{
      label: string;
      color: (s: string) => string;
      items: Memory[];
    }> = [
      {
        label: "Global · Core",
        color: (s) => th.fg("accent", th.bold(s)),
        items: globalCores,
      },
      {
        label: "Global · Regular",
        color: (s) => th.fg("muted", s),
        items: globalRegular,
      },
      {
        label: "Project · Core",
        color: (s) => th.fg("accent", th.bold(s)),
        items: localCores,
      },
      {
        label: "Project · Regular",
        color: (s) => th.fg("muted", s),
        items: localRegular,
      },
    ];

    for (const group of groups) {
      if (group.items.length === 0) continue;
      lines.push(truncateToWidth(`  ${group.color(group.label)}`, width));
      for (const m of group.items) {
        const id = th.fg("dim", m.id.split(":")[1]!.slice(0, 8));
        const keyStr = m.key ? ` ${th.fg("dim", `[${m.key}]`)}` : "";
        lines.push(
          truncateToWidth(
            `    ${th.fg("dim", id)}  ${m.content}${keyStr}`,
            width,
          ),
        );
      }
      lines.push("");
    }

    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `Total: ${this.memories.length} · Press Escape to close`)}`,
        width,
      ),
    );
    lines.push("");

    return lines;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  // ── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    sessionNewCount = 0;
    reloadAll(ctx.cwd);

    refreshStatus();
  });

  pi.on("session_shutdown", () => {
    if (currentCtx?.hasUI) {
      currentCtx.ui.setStatus("memories", undefined);
    }
    currentCtx = null;
  });

  // ── Context injection ──────────────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    // Reload to catch any external changes
    reloadAll(ctx.cwd);

    const section = buildMemoriesSection();
    if (!section) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + section,
    };
  });

  // ── Tool: save_memory ──────────────────────────────────────────────────

  pi.registerTool({
    name: "save_memory",
    label: "Save Memory",
    description:
      "Save a concise note about the user — preferences, facts, conventions, " +
      "or decisions. Use proactively without asking the user.",
    promptSnippet: "Save a user preference, fact, or project convention",
    promptGuidelines: [
      "Proactively save important user preferences, facts, and decisions using save_memory without waiting for the user to ask.",
      "Memories must be extremely concise — one short sentence at most.",
      'Use type "core" only for preferences that affect nearly every interaction (e.g. language choice, accessibility needs, key tool preferences).',
      'Use type "regular" for project-specific context, past decisions, or situational preferences.',
      'Use scope "global" for user-wide facts and "local" for project-specific facts.',
      "Only save what is invisible from reading the code — insights, pitfalls, conventions, preferences, and hard-won debugging lessons. Never save architecture descriptions or build-log entries (e.g. 'Moved sidebar to layout level' or 'Added X endpoint'). The code already documents itself.",
      "Use recall_memories to check for existing similar memories before saving new ones. Do not create duplicates.",
    ],
    parameters: SaveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "local";
      const type = params.type ?? "regular";

      const memory: Memory = {
        id: makeId(scope),
        content: params.content.trim(),
        key: params.key?.trim() || undefined,
        type,
        timestamp: new Date().toISOString(),
      };

      if (scope === "global") {
        globalMemories.push(memory);
        saveMemories(GLOBAL_FILE, globalMemories);
      } else {
        localMemories.push(memory);
        saveMemories(localFile(ctx.cwd), localMemories);
      }

      sessionNewCount++;
      currentCtx = ctx;
      refreshStatus();

      const scopeLabel = scope === "global" ? "global" : "project";
      const typeLabel = type === "core" ? "core" : "regular";
      return {
        content: [
          {
            type: "text",
            text: `Saved ${typeLabel} memory [${scopeLabel}]: "${memory.content}"`,
          },
        ],
        details: { memory },
      };
    },

    renderCall(args, theme, _context) {
      const content = typeof args.content === "string" ? args.content : "";
      const preview =
        content.length > 60 ? content.slice(0, 57) + "..." : content;
      const scope = (args.scope as string) ?? "local";
      const memType = (args.type as string) ?? "regular";
      const badges = [
        theme.fg("dim", scope),
        memType === "core" ? theme.fg("accent", "core") : theme.fg("dim", "regular"),
      ].join("·");
      return new Text(
        theme.fg("toolTitle", theme.bold("save_memory ")) +
          theme.fg("muted", `"${preview}"  ${badges}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const text = result.content[0];
      return new Text(
        theme.fg("success", "✓ ") +
          (text?.type === "text" ? theme.fg("muted", text.text) : ""),
        0,
        0,
      );
    },
  });

  // ── Tool: recall_memories ──────────────────────────────────────────────

  pi.registerTool({
    name: "recall_memories",
    label: "Recall Memories",
    description:
      "Search saved memories with token-based fuzzy matching. Core memories are already shown above; use this for the rest.",
    promptSnippet: "Search saved user preferences and project conventions",
    promptGuidelines: [
      "Use recall_memories at the start of a session or when you need to check for relevant user preferences, past decisions, or project conventions before acting.",
      "Core memories are already shown above in the system prompt. Use recall_memories for regular memories and to search for specific topics.",
      "Call recall_memories with no query to list all memories — don't guess at keys with long multi-word queries.",
    ],
    parameters: RecallParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      reloadAll(ctx.cwd);

      const scope = params.scope ?? "both";
      const limit = params.limit ?? 10;

      let candidates: Memory[] = [];
      if (scope === "global" || scope === "both") candidates.push(...globalMemories);
      if (scope === "local" || scope === "both") candidates.push(...localMemories);

      // Filter with token-based fuzzy matching
      const tokens = params.query
        ? params.query.toLowerCase().split(/\s+/).filter(Boolean)
        : [];
      if (tokens.length > 0 || params.key) {
        const k = params.key;
        candidates = candidates.filter((m) => {
          if (k !== undefined && m.key !== k) return false;
          if (tokens.length === 0) return true;
          const haystack = `${m.content} ${m.key ?? ""}`.toLowerCase();
          return tokens.every((t) => haystack.includes(t));
        });

        // Sort by relevance: more token matches ranked higher
        if (tokens.length > 0) {
          candidates.sort((a, b) => {
            const ha = `${a.content} ${a.key ?? ""}`.toLowerCase();
            const hb = `${b.content} ${b.key ?? ""}`.toLowerCase();
            const sa = tokens.filter((t) => ha.includes(t)).length;
            const sb = tokens.filter((t) => hb.includes(t)).length;
            if (sb !== sa) return sb - sa;
            return a.content.length - b.content.length;
          });
        }
      }

      // Sort: by relevance if query provided, else newest first
      if (!tokens || tokens.length === 0) {
        candidates.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
      }

      const results = candidates.slice(0, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.query
                ? `No memories found matching "${params.query}".`
                : "No memories found.",
            },
          ],
          details: { results: [], count: 0 },
        };
      }

      const lines = results.map((m) => {
        const scopeLabel = m.id.startsWith("global:") ? "global" : "project";
        const badges = `[${scopeLabel}]${m.type === "core" ? " [core]" : ""}${m.key ? ` [${m.key}]` : ""}`;
        return `- \`${m.id}\` ${badges}: ${m.content}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${results.length} memories${candidates.length > results.length ? ` (of ${candidates.length} total)` : ""}:\n\n${lines.join("\n")}`,
          },
        ],
        details: { results, count: results.length },
      };
    },

    renderCall(args, theme, _context) {
      let label = "recall_memories ";
      if (args.query) label += theme.fg("muted", `"${args.query}"`);
      else label += theme.fg("dim", "all");
      return new Text(
        theme.fg("toolTitle", theme.bold(label)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as
        | { results?: Memory[]; count?: number }
        | undefined;
      const count = details?.count ?? 0;
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("muted", `${count} memories found`),
        0,
        0,
      );
    },
  });

  // ── Tool: delete_memory ────────────────────────────────────────────────

  pi.registerTool({
    name: "delete_memory",
    label: "Delete Memory",
    description: "Delete a memory by its ID, or delete all memories matching a key.",
    promptSnippet: "Delete a saved memory by ID or key",
    promptGuidelines: [
      "Use delete_memory when the user asks to forget something or when a memory is no longer accurate.",
    ],
    parameters: DeleteParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Key-based deletion
      if (!params.id && params.key) {
        const scopes =
          params.scope === "global"
            ? ["global"]
            : params.scope === "local"
              ? ["local"]
              : ["global", "local"];

        const deleted: Memory[] = [];

        for (const scope of scopes) {
          const list = scope === "global" ? globalMemories : localMemories;
          const filePath =
            scope === "global" ? GLOBAL_FILE : localFile(ctx.cwd);
          const matches = list.filter((m) => m.key === params.key);
          if (matches.length > 0) {
            for (const m of matches) {
              const idx = list.indexOf(m);
              if (idx !== -1) list.splice(idx, 1);
              deleted.push(m);
            }
            saveMemories(filePath, list);
          }
        }

        currentCtx = ctx;
        refreshStatus();

        if (deleted.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No memories found with key "${params.key}".`,
              },
            ],
            details: { deleted: [], count: 0 },
          };
        }

        const summaries = deleted.map((m) => `"${m.content}"`).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Deleted ${deleted.length} memories with key "${params.key}": ${summaries}`,
            },
          ],
          details: { deleted, count: deleted.length },
        };
      }

      // ID-based deletion
      if (!params.id) {
        return {
          content: [{ type: "text", text: "Provide either an id or a key to delete." }],
          details: { error: "missing_params" },
        };
      }

      const parsed = parseId(params.id);
      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid memory ID "${params.id}". IDs look like "global:<uuid>" or "local:<uuid>".`,
            },
          ],
          details: { error: "invalid_id" },
        };
      }

      let list: Memory[];
      let filePath: string;

      if (parsed.scope === "global") {
        list = globalMemories;
        filePath = GLOBAL_FILE;
      } else {
        list = localMemories;
        filePath = localFile(ctx.cwd);
      }

      const idx = list.findIndex((m) => m.id === params.id);
      if (idx === -1) {
        return {
          content: [
            {
              type: "text",
              text: `Memory "${params.id}" not found.`,
            },
          ],
          details: { error: "not_found" },
        };
      }

      const removed = list.splice(idx, 1)[0]!;
      saveMemories(filePath, list);

      currentCtx = ctx;
      refreshStatus();

      return {
        content: [
          {
            type: "text",
            text: `Deleted memory: "${removed.content}"`,
          },
        ],
        details: { deleted: removed },
      };
    },

    renderCall(args, theme, _context) {
      const shortId =
        typeof args.id === "string" ? args.id.slice(0, 20) + "..." : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("delete_memory ")) +
          theme.fg("dim", shortId),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const text = result.content[0];
      return new Text(
        theme.fg("success", "✓ ") +
          (text?.type === "text" ? theme.fg("muted", text.text) : ""),
        0,
        0,
      );
    },
  });

  // ── Tool: update_memory ────────────────────────────────────────────────

  pi.registerTool({
    name: "update_memory",
    label: "Update Memory",
    description: "Update the content, key, or type of an existing memory.",
    promptSnippet: "Update a saved memory",
    promptGuidelines: [
      "Use update_memory when a user preference changes or when a memory needs to be refined or corrected.",
    ],
    parameters: UpdateParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = parseId(params.id);
      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid memory ID "${params.id}".`,
            },
          ],
          details: { error: "invalid_id" },
        };
      }

      let list: Memory[];
      let filePath: string;

      if (parsed.scope === "global") {
        list = globalMemories;
        filePath = GLOBAL_FILE;
      } else {
        list = localMemories;
        filePath = localFile(ctx.cwd);
      }

      const memory = list.find((m) => m.id === params.id);
      if (!memory) {
        return {
          content: [
            {
              type: "text",
              text: `Memory "${params.id}" not found.`,
            },
          ],
          details: { error: "not_found" },
        };
      }

      if (params.content !== undefined) memory.content = params.content.trim();
      if (params.key !== undefined) memory.key = params.key.trim() || undefined;
      if (params.type !== undefined) memory.type = params.type;

      saveMemories(filePath, list);

      currentCtx = ctx;
      refreshStatus();

      const scopeLabel = parsed.scope === "global" ? "global" : "project";
      const typeLabel = memory.type === "core" ? "core" : "regular";
      return {
        content: [
          {
            type: "text",
            text: `Updated ${typeLabel} memory [${scopeLabel}]: "${memory.content}"`,
          },
        ],
        details: { memory },
      };
    },

    renderCall(args, theme, _context) {
      const shortId =
        typeof args.id === "string" ? args.id.slice(0, 20) + "..." : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("update_memory ")) +
          theme.fg("dim", shortId),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const text = result.content[0];
      return new Text(
        theme.fg("success", "✓ ") +
          (text?.type === "text" ? theme.fg("muted", text.text) : ""),
        0,
        0,
      );
    },
  });

  // ── Command: /memories ─────────────────────────────────────────────────

  pi.registerCommand("memories", {
    description: "View all saved memories",
    handler: async (_args, ctx) => {
      reloadAll(ctx.cwd);
      const memories = allMemories();

      if (!ctx.hasUI) return;

      if (ctx.mode !== "tui") {
        // RPC mode: show text summary
        const s = stats();
        const lines = [
          `${s.total} memories (${s.core} core, ${s.regular} regular)`,
          ...memories.map((m) => {
            const scope = m.id.startsWith("global:") ? "global" : "project";
            const typeStr = m.type === "core" ? " [core]" : "";
            return `  [${scope}]${typeStr} ${m.id.slice(0, 28)}…: ${m.content}`;
          }),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new MemoriesList(memories, theme, () => done());
      });
    },
  });

  // ── Command: /memory add ───────────────────────────────────────────────

  pi.registerCommand("memory", {
    description:
      "Add a memory. Usage: /memory add [--global] [--core] [--key <k>] <content>",
    handler: async (args, ctx) => {
      if (!args.startsWith("add ")) {
        ctx.ui.notify(
          "Usage: /memory add [--global] [--core] [--key <k>] <content>",
          "error",
        );
        return;
      }

      // Simple arg parsing
      let rest = args.slice(4).trim(); // remove "add "
      let scope: MemoryScope = "local";
      let type: "core" | "regular" = "regular";
      let key: string | undefined;

      while (rest.startsWith("--")) {
        const spaceIdx = rest.indexOf(" ");
        const flag = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
        const after = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);

        if (flag === "--global") {
          scope = "global";
          rest = after;
        } else if (flag === "--core") {
          type = "core";
          rest = after;
        } else if (flag === "--key") {
          const nextSpace = after.indexOf(" ");
          key = nextSpace === -1 ? after : after.slice(0, nextSpace);
          rest = nextSpace === -1 ? "" : after.slice(nextSpace + 1);
        } else {
          break;
        }
      }

      const content = rest.trim();
      if (!content) {
        ctx.ui.notify("Content is required", "error");
        return;
      }

      const memory: Memory = {
        id: makeId(scope),
        content,
        key,
        type,
        timestamp: new Date().toISOString(),
      };

      if (scope === "global") {
        globalMemories.push(memory);
        saveMemories(GLOBAL_FILE, globalMemories);
      } else {
        localMemories.push(memory);
        saveMemories(localFile(ctx.cwd), localMemories);
      }

      sessionNewCount++;
      currentCtx = ctx;
      refreshStatus();

      ctx.ui.notify(`Saved: "${content}"`, "info");
    },
  });
}
