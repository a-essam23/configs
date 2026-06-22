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
 *   global -> ~/.pi/agent/configs/memories.json
 *   local  -> <cwd>/.pi/memories.json
 *
 * Tools:     save_memory, list_memories, read_memories, delete_memory, update_memory
 * Commands:  /memories (view all), /memory add (quick add)
 * Widget:    Shows live memory counts below the editor
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
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

const GLOBAL_FILE = path.join(getAgentDir(), "configs", "memories.json");

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

// Dice coefficient on character bigrams for fuzzy matching
function bigrams(s: string): Set<string> {
  const b = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2));
  return b;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 0;
  let overlap = 0;
  for (const bg of ba) if (bb.has(bg)) overlap++;
  return (2 * overlap) / (ba.size + bb.size);
}

type MemoryScopeFilter = "global" | "local" | "both";
type MemoryTypeFilter = "core" | "regular" | "both";

interface MemorySelectionParams {
  ids?: string[];
  keys?: string[];
  slugs?: string[];
  key?: string;
  query?: string;
  scope?: MemoryScopeFilter;
  type?: MemoryTypeFilter;
  limit?: number;
}

function scopeOf(memory: Memory): MemoryScope {
  return memory.id.startsWith("global:") ? "global" : "local";
}

function queryTokens(query?: string): string[] {
  return query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

function memorySearchScore(memory: Memory, tokens: string[]): number {
  if (tokens.length === 0) return 1;

  const haystack = `${memory.content} ${memory.key ?? ""}`.toLowerCase();
  const words = haystack.split(/\s+/).filter(Boolean);
  let totalScore = 0;

  for (const token of tokens) {
    let best = 0;
    for (const word of words) {
      const score = diceCoefficient(token, word);
      if (score > best) best = score;
    }
    if (best < 0.5) return -1;
    totalScore += best;
  }

  return totalScore;
}

function selectMemories(params: MemorySelectionParams): Memory[] {
  const scope = params.scope ?? "both";
  const type = params.type ?? "both";
  const limit = params.limit ?? 0; // 0 = no limit
  const ids = new Set(params.ids ?? []);
  const keys = new Set([...(params.keys ?? []), ...(params.slugs ?? []), ...(params.key ? [params.key] : [])]);
  const tokens = queryTokens(params.query);

  let candidates = allMemories().filter((memory) => {
    const memoryScope = scopeOf(memory);
    if (scope !== "both" && memoryScope !== scope) return false;
    if (type !== "both" && memory.type !== type) return false;
    if (ids.size > 0 || keys.size > 0) {
      return ids.has(memory.id) || (memory.key !== undefined && keys.has(memory.key));
    }
    return true;
  });

  if (tokens.length > 0) {
    const scored = candidates
      .map((memory) => ({ memory, score: memorySearchScore(memory, tokens) }))
      .filter((entry) => entry.score >= 0);
    scored.sort((a, b) => b.score - a.score);
    candidates = scored.map((entry) => entry.memory);
  } else {
    candidates.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  return limit > 0 ? candidates.slice(0, limit) : candidates;
}

function selectWithLimit(params: MemorySelectionParams): { results: Memory[]; total: number } {
  const matches = selectMemories({ ...params, limit: 0 });
  const limit = params.limit ?? 0;
  return {
    results: limit > 0 ? matches.slice(0, limit) : matches,
    total: matches.length,
  };
}

function memoryKey(memory: Memory): string {
  return memory.key ?? memory.id;
}

function formatMemoryList(memories: Memory[], total: number): string {
  if (memories.length === 0) return "No memories found.";
  const lines = memories.map((memory) => `- ${memoryKey(memory)} [${scopeOf(memory)}, ${memory.type}]`);
  const suffix = total > memories.length ? ` (of ${total} total)` : "";
  return `${memories.length} memories${suffix}:\n\n${lines.join("\n")}`;
}

function formatMemoryContent(memories: Memory[], total: number): string {
  if (memories.length === 0) return "No memories found.";
  const lines = memories.map((memory) => {
    const badges = `[${scopeOf(memory)}] [${memory.type}]${memory.key ? ` [${memory.key}]` : ""}`;
    return `- \`${memory.id}\` ${badges}: ${memory.content}`;
  });
  const suffix = total > memories.length ? ` (of ${total} total)` : "";
  return `${memories.length} memories${suffix}:\n\n${lines.join("\n")}`;
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
  const cores = all.filter((m) => m.type === "core");
  const lines: string[] = [];
  lines.push("## Memories");

  // Core memories in full
  if (cores.length > 0) {
    lines.push("Core memories:");
    for (const m of cores) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
  }

  // Compact index of all memory keys (for awareness + duplicate prevention)
  const keys = [...new Set(all.map((m) => m.key).filter(Boolean))];
  if (keys.length > 0) {
    lines.push(`Saved memory keys: ${keys.join(", ")}`);
    lines.push("");
  }

  lines.push("Memory policy:");
  lines.push("- Consider saving a memory when the user states a durable preference, corrects your behavior, establishes a project convention, or you discover a non-obvious pitfall that would prevent future mistakes.");
  lines.push("- Save only if the memory would change future assistant behavior and is not obvious from code, docs, git history, or the current task.");
  lines.push("- When the save criteria are met, call save_memory before the final answer.");
  lines.push("- Do not save task progress, implementation summaries, build logs, architecture descriptions, or one-off facts.");
  lines.push("- If a similar memory may already exist, use list_memories/read_memories before saving.");
  lines.push("- If unsure whether something is durable, reusable, and invisible from code, do not save it.");
  lines.push("Use list_memories to inspect available memories. Use read_memories with exact keys/ids/slugs for full content.");

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

const ListParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Fuzzy search term — tokens are matched against content and key",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "Filter by exact key/title/slug",
    }),
  ),
  scope: Type.Optional(
    StringEnum(["global", "local", "both"] as const, {
      description: "Which scopes to list. Default: both.",
    }),
  ),
  type: Type.Optional(
    StringEnum(["core", "regular", "both"] as const, {
      description: "Which memory types to list. Default: both.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results to return. Default: 0 (no cap).",
    }),
  ),
});

const ReadParams = Type.Object({
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Memory IDs to read",
    }),
  ),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: "Memory keys/titles/slugs to read",
    }),
  ),
  slugs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Alias for keys",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "Single key/title/slug to read",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Fuzzy search term — tokens are matched against content and key",
    }),
  ),
  scope: Type.Optional(
    StringEnum(["global", "local", "both"] as const, {
      description: "Which scopes to read. Default: both.",
    }),
  ),
  type: Type.Optional(
    StringEnum(["core", "regular", "both"] as const, {
      description: "Which memory types to read. Default: both.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results to return. Default: 0 (no cap).",
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
  private cwd: string;
  private requestRender: () => void;
  private onClose: () => void;
  private selected = 0;
  private expanded = new Set<string>();
  private pendingDeleteId: string | undefined;
  private message: string | undefined;

  constructor(options: {
    memories: Memory[];
    theme: Theme;
    cwd: string;
    requestRender: () => void;
    onClose: () => void;
  }) {
    this.memories = this.orderMemories(options.memories);
    this.theme = options.theme;
    this.cwd = options.cwd;
    this.requestRender = options.requestRender;
    this.onClose = options.onClose;
  }

  invalidate(): void {}

  private orderMemories(memories: Memory[]): Memory[] {
    const rank = (m: Memory) => {
      const scopeRank = m.id.startsWith("global:") ? 0 : 2;
      const typeRank = m.type === "core" ? 0 : 1;
      return scopeRank + typeRank;
    };
    return [...memories].sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }

  private reload(): void {
    reloadAll(this.cwd);
    this.memories = this.orderMemories(allMemories());
    if (this.selected >= this.memories.length) {
      this.selected = Math.max(0, this.memories.length - 1);
    }
  }

  private selectedMemory(): Memory | undefined {
    return this.memories[this.selected];
  }

  private deleteSelected(): void {
    const memory = this.selectedMemory();
    if (!memory) return;

    const parsed = parseId(memory.id);
    if (!parsed) {
      this.message = `Invalid memory id: ${memory.id}`;
      return;
    }

    const list = parsed.scope === "global" ? globalMemories : localMemories;
    const filePath = parsed.scope === "global" ? GLOBAL_FILE : localFile(this.cwd);
    const idx = list.findIndex((m) => m.id === memory.id);
    if (idx === -1) {
      this.message = `Memory not found: ${memoryKey(memory)}`;
      this.reload();
      return;
    }

    const removed = list.splice(idx, 1)[0]!;
    saveMemories(filePath, list);
    this.expanded.delete(removed.id);
    this.pendingDeleteId = undefined;
    this.reload();
    refreshStatus();
    this.message = `Deleted ${memoryKey(removed)}`;
  }

  private toggleSelectedType(): void {
    const memory = this.selectedMemory();
    if (!memory) return;

    const parsed = parseId(memory.id);
    if (!parsed) {
      this.message = `Invalid memory id: ${memory.id}`;
      return;
    }

    const list = parsed.scope === "global" ? globalMemories : localMemories;
    const filePath = parsed.scope === "global" ? GLOBAL_FILE : localFile(this.cwd);
    const target = list.find((m) => m.id === memory.id);
    if (!target) {
      this.message = `Memory not found: ${memoryKey(memory)}`;
      this.reload();
      return;
    }

    target.type = target.type === "core" ? "regular" : "core";
    saveMemories(filePath, list);
    this.reload();
    const newIndex = this.memories.findIndex((m) => m.id === target.id);
    if (newIndex !== -1) this.selected = newIndex;
    refreshStatus();
    this.message = `Changed ${memoryKey(target)} to ${target.type}`;
  }

  private switchSelectedScope(): void {
    const memory = this.selectedMemory();
    if (!memory) return;

    const parsed = parseId(memory.id);
    if (!parsed) {
      this.message = `Invalid memory id: ${memory.id}`;
      return;
    }

    const fromList = parsed.scope === "global" ? globalMemories : localMemories;
    const toScope: MemoryScope = parsed.scope === "global" ? "local" : "global";
    const toList = toScope === "global" ? globalMemories : localMemories;
    const fromFile = parsed.scope === "global" ? GLOBAL_FILE : localFile(this.cwd);
    const toFile = toScope === "global" ? GLOBAL_FILE : localFile(this.cwd);
    const idx = fromList.findIndex((m) => m.id === memory.id);
    if (idx === -1) {
      this.message = `Memory not found: ${memoryKey(memory)}`;
      this.reload();
      return;
    }

    const [removed] = fromList.splice(idx, 1);
    const moved: Memory = { ...removed!, id: makeId(toScope) };
    toList.push(moved);
    saveMemories(fromFile, fromList);
    saveMemories(toFile, toList);

    if (this.expanded.delete(memory.id)) this.expanded.add(moved.id);
    this.pendingDeleteId = undefined;
    this.reload();
    const newIndex = this.memories.findIndex((m) => m.id === moved.id);
    if (newIndex !== -1) this.selected = newIndex;
    refreshStatus();
    this.message = `Moved ${memoryKey(moved)} to ${toScope === "global" ? "global" : "project"}`;
  }

  handleInput(data: string): void {
    if (this.pendingDeleteId) {
      if (matchesKey(data, "y") || data === "Y") {
        this.deleteSelected();
        this.requestRender();
        return;
      }
      if (
        matchesKey(data, "n") ||
        data === "N" ||
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        this.pendingDeleteId = undefined;
        this.message = "Delete cancelled";
        this.requestRender();
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
      this.onClose();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.message = undefined;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selected = Math.min(Math.max(0, this.memories.length - 1), this.selected + 1);
      this.message = undefined;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      const memory = this.selectedMemory();
      if (memory) {
        if (this.expanded.has(memory.id)) this.expanded.delete(memory.id);
        else this.expanded.add(memory.id);
        this.message = undefined;
        this.requestRender();
      }
      return;
    }

    if (matchesKey(data, "d")) {
      const memory = this.selectedMemory();
      if (memory) {
        this.pendingDeleteId = memory.id;
        this.message = undefined;
        this.requestRender();
      }
      return;
    }

    if (matchesKey(data, "t")) {
      this.toggleSelectedType();
      this.requestRender();
      return;
    }

    if (matchesKey(data, "s")) {
      this.switchSelectedScope();
      this.requestRender();
      return;
    }

    if (matchesKey(data, "r")) {
      this.reload();
      this.message = "Reloaded memories";
      this.requestRender();
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
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑/↓/j/k select · Enter expand · t core/regular · s local/global · d delete · r reload · q close")}`,
        width,
      ),
    );
    lines.push("");

    if (this.memories.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No memories yet. The agent will save them as you work.")}`,
          width,
        ),
      );
    }

    let previousGroup = "";
    for (const [index, memory] of this.memories.entries()) {
      const scope = scopeOf(memory);
      const group = `${scope === "global" ? "Global" : "Project"} · ${memory.type === "core" ? "Core" : "Regular"}`;
      if (group !== previousGroup) {
        if (previousGroup) lines.push("");
        const color = memory.type === "core" ? (s: string) => th.fg("accent", th.bold(s)) : (s: string) => th.fg("muted", s);
        lines.push(truncateToWidth(`  ${color(group)}`, width));
        previousGroup = group;
      }

      const selected = index === this.selected;
      const marker = selected ? th.fg("accent", ">") : " ";
      const key = memory.key ?? memory.id.split(":")[1]!.slice(0, 8);
      const badges = th.fg("dim", `[${scope} ${memory.type}]`);
      const label = `${marker} ${badges} ${th.bold(key)}`;
      const expanded = this.expanded.has(memory.id);

      if (expanded) {
        lines.push(truncateToWidth(`  ${label}`, width));
        lines.push(truncateToWidth(`      ${th.fg("dim", `id: ${memory.id}`)}`, width));
        lines.push(truncateToWidth(`      ${th.fg("dim", `saved: ${memory.timestamp}`)}`, width));
        for (const line of wrapTextWithAnsi(memory.content, Math.max(10, width - 6))) {
          lines.push(truncateToWidth(`      ${line}`, width));
        }
      } else {
        const previewWidth = Math.max(10, width - 8);
        const preview = truncateToWidth(memory.content, previewWidth);
        lines.push(truncateToWidth(`  ${label}  ${preview}`, width));
      }
    }

    lines.push("");
    if (this.pendingDeleteId) {
      const memory = this.selectedMemory();
      const name = memory ? memoryKey(memory) : this.pendingDeleteId;
      lines.push(truncateToWidth(`  ${th.fg("error", `Delete ${name}?`)} ${th.fg("dim", "y/N")}`, width));
    } else if (this.message) {
      lines.push(truncateToWidth(`  ${th.fg("muted", this.message)}`, width));
    }
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `Total: ${this.memories.length}`)}`,
        width,
      ),
    );
    lines.push("");

    return lines;
  }
}

class MemoriesPreview {
  private section: string;
  private theme: Theme;
  private onClose: () => void;

  constructor(section: string, theme: Theme, onClose: () => void) {
    this.section = section;
    this.theme = theme;
    this.onClose = onClose;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    lines.push("");
    const title = th.fg("accent", " Memories Prompt Preview ");
    const header =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 27)));
    lines.push(truncateToWidth(header, width));
    lines.push(truncateToWidth(`  ${th.fg("dim", "This is appended to the system prompt by the memories extension. · q close")}`, width));
    lines.push("");

    for (const rawLine of this.section.split("\n")) {
      if (rawLine.length === 0) {
        lines.push("");
        continue;
      }
      for (const line of wrapTextWithAnsi(rawLine, Math.max(10, width - 4))) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
    }

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
      "Save a high-confidence durable memory about the user — preferences, facts, " +
      "conventions, decisions, or hard-won lessons. Use without asking only when it meets the memory policy.",
    promptSnippet: "Save a durable preference, convention, correction, or hard-won lesson",
    promptGuidelines: [
      "Consider save_memory when the user states a durable preference, corrects your behavior, establishes a project convention, or you discover a non-obvious pitfall that would prevent future mistakes.",
      "Save only if the memory would change future assistant behavior and is not obvious from code, docs, git history, or the current task.",
      "When the save criteria are met, call save_memory before the final answer.",
      "Do not save task progress, implementation summaries, build logs, architecture descriptions, or one-off facts.",
      "Memories must be extremely concise — one short sentence at most.",
      'Use type "core" rarely, only for preferences that affect nearly every interaction (e.g. language choice, accessibility needs, key tool preferences).',
      'Use type "regular" for project-specific context, past decisions, situational preferences, and hard-won gotchas.',
      'Use scope "global" for user-wide facts and "local" for project-specific facts.',
      "Good memories: durable preferences, project conventions, user corrections, design intent not visible from code, or hard-won debugging lessons.",
      "Bad memories: 'Added X endpoint', 'Moved sidebar rendering', 'Implemented Redis sessions', or 'Current task is to fix login'.",
      "Use list_memories or read_memories to check for existing similar memories before saving new ones. Do not create duplicates.",
      "If unsure whether something is durable, reusable, and invisible from code, do not save it.",
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

  // ── Shared memory read/list executors ───────────────────────────────

  async function executeListMemories(params: MemorySelectionParams, ctx: ExtensionContext) {
    reloadAll(ctx.cwd);
    const { results, total } = selectWithLimit(params);
    return {
      content: [{ type: "text" as const, text: formatMemoryList(results, total) }],
      details: {
        results: results.map((memory) => ({
          id: memory.id,
          key: memory.key,
          type: memory.type,
          scope: scopeOf(memory),
          timestamp: memory.timestamp,
        })),
        count: results.length,
        total,
      },
    };
  }

  async function executeReadMemories(params: MemorySelectionParams, ctx: ExtensionContext) {
    reloadAll(ctx.cwd);
    const { results, total } = selectWithLimit(params);
    return {
      content: [{ type: "text" as const, text: formatMemoryContent(results, total) }],
      details: { results, count: results.length, total },
    };
  }

  function renderMemorySearchCall(toolName: string, args: { query?: unknown; key?: unknown; keys?: unknown; slugs?: unknown; ids?: unknown }, theme: Theme) {
    let label = `${toolName} `;
    if (typeof args.query === "string") label += theme.fg("muted", `"${args.query}"`);
    else if (typeof args.key === "string") label += theme.fg("muted", args.key);
    else if (Array.isArray(args.keys) && args.keys.length > 0) label += theme.fg("muted", args.keys.join(", "));
    else if (Array.isArray(args.slugs) && args.slugs.length > 0) label += theme.fg("muted", args.slugs.join(", "));
    else if (Array.isArray(args.ids) && args.ids.length > 0) label += theme.fg("dim", `${args.ids.length} id(s)`);
    else label += theme.fg("dim", "all");
    return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
  }

  function renderMemoryCount(result: { details?: unknown }, theme: Theme, noun = "memories") {
    const details = result.details as { count?: number; total?: number } | undefined;
    const count = details?.count ?? 0;
    const total = details?.total;
    const suffix = total !== undefined && total !== count ? ` of ${total}` : "";
    return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${count}${suffix} ${noun}`), 0, 0);
  }

  function renderMemoryReadResult(result: { details?: unknown }, theme: Theme) {
    const details = result.details as {
      count?: number;
      total?: number;
      results?: Array<{ id?: string; key?: string }>;
    } | undefined;
    const count = details?.count ?? 0;
    const total = details?.total;
    const suffix = total !== undefined && total !== count ? ` of ${total}` : "";
    const names = (details?.results ?? []).map((memory) => memory.key || memory.id || "(unnamed)");
    const namesSuffix = names.length > 0 ? `: ${names.join(", ")}` : "";
    return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${count}${suffix} memories read${namesSuffix}`), 0, 0);
  }

  // ── Tool: list_memories ────────────────────────────────────────────────

  pi.registerTool({
    name: "list_memories",
    label: "List Memories",
    description: "List saved memories as a slim key/title index. Supports fuzzy search without returning full content.",
    promptSnippet: "List saved memory keys/titles with optional fuzzy search",
    promptGuidelines: [
      "Use list_memories to inspect available memories without loading full content.",
      "Use list_memories with no query to list all memory keys/titles.",
      "Use list_memories with a short fuzzy query to find candidate keys before calling read_memories.",
    ],
    parameters: ListParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeListMemories(params, ctx);
    },

    renderCall(args, theme, _context) {
      return renderMemorySearchCall("list_memories", args, theme);
    },

    renderResult(result, _options, theme, _context) {
      return renderMemoryCount(result, theme, "memories listed");
    },
  });

  // ── Tool: read_memories ────────────────────────────────────────────────

  pi.registerTool({
    name: "read_memories",
    label: "Read Memories",
    description: "Read full memory content by id, key/title/slug, or fuzzy query.",
    promptSnippet: "Read full saved memory content by key/title/slug, id, or fuzzy search",
    promptGuidelines: [
      "Use read_memories when you need full memory content. Prefer exact keys/slugs from the system prompt or list_memories.",
      "Use read_memories with keys or slugs when possible; use query only when the exact key is unknown.",
    ],
    parameters: ReadParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeReadMemories(params, ctx);
    },

    renderCall(args, theme, _context) {
      return renderMemorySearchCall("read_memories", args, theme);
    },

    renderResult(result, _options, theme, _context) {
      return renderMemoryReadResult(result, theme);
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
    description: "Browse, expand, delete, and preview saved memories",
    handler: async (args, ctx) => {
      reloadAll(ctx.cwd);
      const memories = allMemories();
      const mode = args.trim();

      if (!ctx.hasUI) return;

      if (mode === "preview") {
        const section = buildMemoriesSection();
        if (ctx.mode !== "tui") {
          ctx.ui.notify(section, "info");
          return;
        }

        await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          return new MemoriesPreview(section, theme, () => done());
        });
        return;
      }

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

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        return new MemoriesList({
          memories,
          theme,
          cwd: ctx.cwd,
          requestRender: () => tui.requestRender(),
          onClose: () => done(),
        });
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
