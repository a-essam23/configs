/**
 * Session Traversal Extension
 *
 * Read-only tools for LLMs to explore Pi sessions on disk.
 * All output is compact JSON — this is 100% LLM-consumed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Helpers ────────────────────────────────────────────────────────────────

function openSM(sessionPath: string): SessionManager | null {
  try { return SessionManager.open(sessionPath); } catch { return null; }
}

function getEntry(sm: SessionManager, id: string): SessionEntry | undefined {
  const e = sm.getEntry(id);
  if (e) return e;
  const m = sm.getEntries().filter((x) => x.id.startsWith(id));
  return m.length === 1 ? m[0] : undefined;
}

function snippet(entry: SessionEntry, max = 120): string {
  if (entry.type !== "message") {
    if (entry.type === "compaction" || entry.type === "branch_summary") return ((entry as any).summary ?? "").slice(0, max);
    if (entry.type === "label") return (entry as any).label ?? "";
    if (entry.type === "session_info") return (entry as any).name ?? "";
    if (entry.type === "model_change") return `${(entry as any).provider}/${(entry as any).modelId}`;
    if (entry.type === "thinking_level_change") return `${(entry as any).thinkingLevel}`;
    if (entry.type === "custom" || entry.type === "custom_message") return `[${(entry as any).customType}]`;
    return "";
  }
  const c = entry.message.content;
  if (Array.isArray(c)) {
    const t = c.find((x: any) => x.type === "text")?.text;
    if (t) return t.slice(0, max);
    const tc = c.find((x: any) => x.type === "toolCall");
    if (tc) return `toolCall:${tc.name}`;
    const th = c.find((x: any) => x.type === "thinking");
    if (th?.thinking) return th.thinking.slice(0, max);
  } else if (typeof c === "string") return c.slice(0, max);
  if ((entry.message as any).role === "bashExecution") return ((entry.message as any).output ?? "").slice(0, max);
  if ((entry.message as any).role === "toolResult") {
    const r = (entry.message as any).content;
    if (Array.isArray(r)) return r.find((x: any) => x.type === "text")?.text?.slice(0, max) ?? "";
  }
  return "";
}

function role(entry: SessionEntry): string {
  if (entry.type !== "message") return entry.type;
  const r = entry.message.role;
  return r === "toolResult" ? `toolResult:${(entry.message as any).toolName ?? ""}` : r;
}

function trySM(ctx: any, sessionPath?: string): SessionManager | null {
  return sessionPath ? openSM(sessionPath) : (ctx.sessionManager as any) ?? null;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── session_list ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_list",
    label: "List Sessions",
    description: "List all Pi session files for the current project, sorted by most recent first. Returns paths usable with session_path of other tools.",
    promptSnippet: "List Pi session files for the current project with paths and metadata",
    promptGuidelines: ["Use session_list first to find session paths, then pass them to other session_* tools."],
    parameters: Type.Object({}),
    async execute(_id, _p, _s, _u, ctx) {
      const sessions = await SessionManager.list(ctx.cwd);
      sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      return {
        content: [{ type: "text", text: JSON.stringify({ count: sessions.length, cwd: ctx.cwd, sessions: sessions.map((s) => ({ path: s.path, id: s.id, cwd: s.cwd || undefined, name: s.name || undefined, parentSession: s.parentSessionPath || undefined, created: s.created.toISOString(), modified: s.modified.toISOString(), messageCount: s.messageCount, firstMessage: s.firstMessage?.slice(0, 200) ?? null })) }) }],
        details: { count: sessions.length },
      };
    },
  });

  // ── session_info ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_info",
    label: "Session Info",
    description: "Show metadata about a session. Omit session_path to inspect the current session.",
    promptSnippet: "Show session metadata overview",
    parameters: Type.Object({
      session_path: Type.Optional(Type.String({ description: "Path to the session .jsonl file. Omit to use the current session." })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      const sm = trySM(ctx, params.session_path);
      if (!sm) return { content: [{ type: "text", text: JSON.stringify({ error: `Cannot open session: ${params.session_path}` }) }], isError: true, details: {} };

      const entries = sm.getEntries();
      const header = sm.getHeader();
      const breakdown: Record<string, number> = {};
      let msgCount = 0, cost = 0;
      for (const e of entries) {
        breakdown[e.type] = (breakdown[e.type] ?? 0) + 1;
        if (e.type === "message") msgCount++;
        if (e.type === "message" && (e.message as any).usage?.cost?.total != null) cost += (e.message as any).usage.cost.total;
      }

      const modelChanges = entries.filter((e) => e.type === "model_change").map((e) => ({ timestamp: e.timestamp, provider: (e as any).provider, modelId: (e as any).modelId }));
      const labels: Array<{ entryId: string; label: string }> = [];
      for (const e of entries) { const l = sm.getLabel(e.id); if (l) labels.push({ entryId: e.id, label: l }); }

      return {
        content: [{ type: "text", text: JSON.stringify({
          sessionId: sm.getSessionId(), file: sm.getSessionFile() ?? null, cwd: sm.getCwd(),
          name: sm.getSessionName() ?? null, parentSession: header?.parentSession ?? null,
          created: header?.timestamp ?? null, totalEntries: entries.length, messageCount: msgCount,
          totalCost: cost > 0 ? Number(cost.toFixed(6)) : 0, currentLeaf: sm.getLeafId(),
          entryBreakdown: breakdown,
          modelChanges: modelChanges.length > 0 ? modelChanges : undefined,
          labels: labels.length > 0 ? labels : undefined,
        }) }],
        details: { session: sm.getSessionFile() ?? "(ephemeral)" },
      };
    },
  });

  // ── session_tree ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_tree",
    label: "Session Tree",
    description: "Show the session tree as a flat entry array ordered root-first. Each entry has parentId for tree reconstruction. Snippets excluded — use session_get_entry or session_get_entries for full content.",
    promptSnippet: "Show the session tree as flat entry list with IDs and parent references (no snippets)",
    parameters: Type.Object({
      session_path: Type.Optional(Type.String({ description: "Path to the session .jsonl file. Omit to use the current session." })),
      entry_id: Type.Optional(Type.String({ description: "If set, only show the subtree rooted at this entry ID (or short prefix)." })),
      limit: Type.Optional(Type.Number({ description: "Max entries to return (default: no limit). Use when the session is large." })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      const sm = trySM(ctx, params.session_path);
      if (!sm) return { content: [{ type: "text", text: JSON.stringify({ error: `Cannot open session: ${params.session_path}` }) }], isError: true, details: {} };

      const all = sm.getTree();
      let roots = all;
      const leafId = sm.getLeafId();

      if (params.entry_id) {
        const target = getEntry(sm, params.entry_id);
        if (!target) return { content: [{ type: "text", text: JSON.stringify({ error: `Entry not found: "${params.entry_id}"` }) }], isError: true, details: {} };
        const find = (nodes: SessionTreeNode[], id: string): SessionTreeNode[] | null => {
          for (const n of nodes) { if (n.entry.id === id) return [n]; const f = find(n.children, id); if (f) return f; }
          return null;
        };
        const subtree = find(all, target.id);
        if (subtree) roots = subtree;
        else roots = [{ entry: target, children: sm.getChildren(target.id).map((c) => ({ entry: c, children: [] })), label: sm.getLabel(target.id), id: target.id } as any];
      }

      const entries: any[] = [];
      const limit = params.limit ?? 0;
      function walk(nodes: SessionTreeNode[]) {
        for (const n of nodes) {
          if (limit > 0 && entries.length >= limit) return;
          entries.push({
            id: n.entry.id, parentId: n.entry.parentId, type: n.entry.type, role: role(n.entry),
            timestamp: n.entry.timestamp, label: n.label ?? null, isLeaf: n.entry.id === leafId,
          });
          walk(n.children);
        }
      }
      walk(roots);

      return {
        content: [{ type: "text", text: JSON.stringify({ session: sm.getSessionFile() ?? "(ephemeral)", leaf: leafId, entryCount: entries.length, truncated: limit > 0 && entries.length >= limit, entries }) }],
        details: { session: sm.getSessionFile() ?? "(ephemeral)" },
      };
    },
  });

  // ── session_get_entry ────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_get_entry",
    label: "Get Entry",
    description: "Get the full content of a single session entry by ID. Accepts short (8-char) prefix or full entry ID.",
    promptSnippet: "Retrieve the full content of a session entry by its ID",
    parameters: Type.Object({
      entry_id: Type.String({ description: "Entry ID or short prefix (8+ chars from session_tree output)." }),
      session_path: Type.Optional(Type.String({ description: "Path to the session .jsonl file. Omit to use the current session." })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      const sm = trySM(ctx, params.session_path);
      if (!sm) return { content: [{ type: "text", text: JSON.stringify({ error: `Cannot open session: ${params.session_path}` }) }], isError: true, details: {} };

      const entry = getEntry(sm, params.entry_id);
      if (!entry) {
        const matches = sm.getEntries().filter((e) => e.id.startsWith(params.entry_id));
        if (matches.length > 1) return { content: [{ type: "text", text: JSON.stringify({ error: `Ambiguous ID "${params.entry_id}"`, matches: matches.map((m) => ({ id: m.id, role: role(m), snippet: snippet(m, 80) })) }) }], isError: true, details: {} };
        return { content: [{ type: "text", text: JSON.stringify({ error: `Entry not found: "${params.entry_id}"` }) }], isError: true, details: {} };
      }

      const result: any = { ...entry };
      const label = sm.getLabel(entry.id);
      if (label) result.label = label;

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { entryId: entry.id, type: entry.type },
      };
    },
  });

  // ── session_get_entries ────────────────────────────────────────────────
  pi.registerTool({
    name: "session_get_entries",
    label: "Get Entries",
    description: "Get the full content of multiple session entries by ID. Accepts short (8-char) prefixes or full entry IDs. Returns an array of entry objects.",
    promptSnippet: "Retrieve the full content of multiple session entries by their IDs",
    parameters: Type.Object({
      entry_ids: Type.Array(Type.String({ description: "Entry IDs or short prefixes to fetch." }), { minItems: 1, maxItems: 50 }),
      session_path: Type.Optional(Type.String({ description: "Path to the session .jsonl file. Omit to use the current session." })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      const sm = trySM(ctx, params.session_path);
      if (!sm) return { content: [{ type: "text", text: JSON.stringify({ error: `Cannot open session: ${params.session_path}` }) }], isError: true, details: {} };

      const results: any[] = [];
      const errors: Array<{ id: string; error: string }> = [];

      for (const rawId of params.entry_ids) {
        const entry = getEntry(sm, rawId);
        if (!entry) {
          const matches = sm.getEntries().filter((e) => e.id.startsWith(rawId));
          if (matches.length > 1) errors.push({ id: rawId, error: `Ambiguous (matches ${matches.length})` });
          else errors.push({ id: rawId, error: "Not found" });
          continue;
        }
        const result: any = { ...entry };
        const label = sm.getLabel(entry.id);
        if (label) result.label = label;
        results.push(result);
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ fetched: results.length, errors: errors.length > 0 ? errors : undefined, entries: results }) }],
        details: { fetched: results.length },
      };
    },
  });

  // ── session_search ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "session_search",
    label: "Search Session",
    description: "Search session entries by text content or role. Returns matching entry IDs and snippets.",
    promptSnippet: "Search through session entries for matching text or role",
    parameters: Type.Object({
      query: Type.String({ description: "Text to search for (case-insensitive)." }),
      session_path: Type.Optional(Type.String({ description: "Path to the session .jsonl file. Omit to search the current session." })),
      role: Type.Optional(Type.String({ description: "Filter by role: user, assistant, toolResult, bashExecution, compaction, branch_summary, label." })),
      max_results: Type.Optional(Type.Number({ description: "Maximum results to return (default: 20)." })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      const sm = trySM(ctx, params.session_path);
      if (!sm) return { content: [{ type: "text", text: JSON.stringify({ error: `Cannot open session: ${params.session_path}` }) }], isError: true, details: {} };

      const q = params.query.toLowerCase();
      const max = params.max_results ?? 20;
      const roleFilter = params.role?.toLowerCase();
      const results: Array<{ id: string; type: string; role: string; snippet: string; timestamp: string }> = [];

      for (const entry of sm.getEntries()) {
        if (results.length >= max) break;
        if (roleFilter) { const r = role(entry).toLowerCase(); if (!r.includes(roleFilter) && entry.type !== roleFilter) continue; }

        const ex = snippet(entry, 200).toLowerCase();
        if (ex.includes(q)) { results.push({ id: entry.id, type: entry.type, role: role(entry), snippet: snippet(entry, 200), timestamp: entry.timestamp }); continue; }

        if (entry.type === "message") {
          const msg = entry.message; const c = msg.content;
          let found = false;
          if (Array.isArray(c)) for (const b of c) { if ((b.type === "text" && b.text?.toLowerCase().includes(q)) || (b.type === "thinking" && b.thinking?.toLowerCase().includes(q))) { found = true; break; } }
          else if (typeof c === "string" && c.toLowerCase().includes(q)) found = true;
          if (!found && "output" in msg && typeof (msg as any).output === "string" && (msg as any).output.toLowerCase().includes(q)) found = true;
          if (found) results.push({ id: entry.id, type: entry.type, role: role(entry), snippet: snippet(entry, 200), timestamp: entry.timestamp });
        } else if (JSON.stringify(entry).toLowerCase().includes(q) && !results.some((r) => r.id === entry.id)) {
          results.push({ id: entry.id, type: entry.type, role: role(entry), snippet: snippet(entry, 200), timestamp: entry.timestamp });
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ query: params.query, session: sm.getSessionFile() ?? "(ephemeral)", matches: results.length, truncated: results.length >= max, results }) }],
        details: { query: params.query, matches: results.length },
      };
    },
  });
}
