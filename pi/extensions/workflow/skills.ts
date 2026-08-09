/**
 * Skills Extension
 *
 * Replaces Pi's built-in skills XML system prompt with a clean markdown list,
 * and provides a `load_skill` tool for the LLM to load skill instructions on demand.
 * Supports custom ordering of skills via a `reorder_skills` tool and `/skills` command.
 *
 * Pi still discovers skills normally. This extension:
 * 1. Strips the `<available_skills>` XML block from the system prompt
 * 2. Inserts a plain markdown list of skill names + descriptions (respecting order)
 * 3. Registers a `load_skill` tool the LLM calls to load a specific skill's SKILL.md
 * 4. Registers a `reorder_skills` tool and `/skills` command to set skill order
 */

import {
  type ExtensionAPI,
  type Skill,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

// ── Known delimiter for the skills section Pi renders ──────────────────────
const SKILLS_HEADER =
  "\n\nThe following skills provide specialized instructions for specific tasks.";

// ── Module-level cache: refreshed every turn from systemPromptOptions ──────
let skillsList: Skill[] = [];

// ── Order file ─────────────────────────────────────────────────────────────
const ORDER_FILE = path.join(getAgentDir(), "configs", "skills-order.json");

function loadOrder(): string[] {
  try {
    const raw = JSON.parse(fsSync.readFileSync(ORDER_FILE, "utf-8"));
    return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function saveOrder(names: string[]): void {
  const dir = path.dirname(ORDER_FILE);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(ORDER_FILE, JSON.stringify(names, null, 2), "utf-8");
  } catch {
    // Non-fatal — order persistence is best-effort
  }
}

/** Sort skills by the saved order: ordered skills first, then the rest in discovery order. */
function applyOrder(skills: Skill[], order: string[]): Skill[] {
  const orderIndex = new Map(order.map((name, i) => [name, i]));
  const known: Skill[] = [];
  const unknown: Skill[] = [];
  for (const s of skills) {
    if (orderIndex.has(s.name)) {
      known.push(s);
    } else {
      unknown.push(s);
    }
  }
  known.sort((a, b) => (orderIndex.get(a.name) ?? 0) - (orderIndex.get(b.name) ?? 0));
  return [...known, ...unknown];
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatList(skills: Skill[]): string[] {
  if (skills.length === 0) return ["No skills available."];
  return [
    "Available skills: " + skills.map((s) => s.name).join(", "),
    "",
    "Call load_skill() with no args to list, or load_skill(name=\"...\") / load_skill(names=[...]) to load.",
  ];
}

function loadOrderSync(): string[] {
  try {
    const raw = JSON.parse(fsSync.readFileSync(ORDER_FILE, "utf-8"));
    return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

// ── Export for cross-extension use ──────────────────────────────────────────
export { applyOrder, loadOrder }; 

export default function skillsExtension(pi: ExtensionAPI) {
  // ── before_agent_start: strip XML block, insert ordered markdown list ──
  pi.on("before_agent_start", async (event) => {
    const rawSkills = event.systemPromptOptions.skills ?? [];
    const order = loadOrder();
    skillsList = applyOrder(
      rawSkills.filter((s: Skill) => !s.disableModelInvocation),
      order,
    );

    if (skillsList.length === 0) return;

    const END_TAG = "</available_skills>";

    const startIdx = event.systemPrompt.indexOf(SKILLS_HEADER);
    if (startIdx === -1) return;

    const endIdx = event.systemPrompt.indexOf(END_TAG, startIdx);
    if (endIdx === -1) return;

    // Preserve everything before the skills section and after the closing tag
    const before = event.systemPrompt.slice(0, startIdx);
    const after = event.systemPrompt.slice(endIdx + END_TAG.length);

    const names = skillsList.map((s) => s.name).join(", ");
    const block = [
      SKILLS_HEADER,
      "Use the load_skill tool to load a skill when the task matches its description.",
      "",
      `Available skills: ${names}`,
      "",
      'Call load_skill() with no args to list, or load_skill(name="...") / load_skill(names=[...]) to load.',
    ].join("\n");

    return {
      systemPrompt: before + block + after,
    };
  });

  // ── load_skill tool ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description:
      "Load one or more skills by name. Call with no arguments to list " +
      "available skills, then load by name or names array. Each skill's " +
      "instructions tell you how to use specialized tools and workflows.",
    promptSnippet: "Load available skill instructions by name",
    promptGuidelines: [
      "Use load_skill() with no arguments to see available skill names.",
      'Use load_skill(name="...") or load_skill(names=[...]) to load skill instructions.',
      "After loading a skill, follow its setup and usage instructions to complete the task.",
    ],
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Skill name to load. Omit to list available skills.",
        }),
      ),
      names: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "One or more skill names to load. Use when you need multiple skills at once.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // ── Collect candidate names to load ─────────────────────────────
      const candidateNames: string[] = [];
      if (params.name) candidateNames.push(params.name);
      if (params.names) candidateNames.push(...params.names);

      // Deduplicate and strip empties
      const allNames = [...new Set(candidateNames.filter(Boolean))];
      const knownNames = new Set(skillsList.map((s) => s.name));

      // ── No valid names → list mode ────────────────────────────────
      if (allNames.length === 0 || !allNames.some((n) => knownNames.has(n))) {
        const hint =
          allNames.length > 0
            ? `No skill named "${allNames[0]}" found. `
            : "";
        return {
          content: [{ type: "text", text: hint + formatList(skillsList).join("\n") }],
          details: {
            skills: skillsList.map((s) => ({
              name: s.name,
              description: s.description,
            })),
          },
        };
      }

      // ── Load each skill ─────────────────────────────────────────────
      const results: string[] = [];
      const errors: string[] = [];
      const availableNames = skillsList.map((s) => s.name);

      for (const rawName of [...new Set(allNames)]) {
        const skill = skillsList.find((s) => s.name === rawName);
        if (!skill) {
          errors.push(`"${rawName}" not found`);
          continue;
        }
        try {
          const content = await fs.readFile(skill.filePath, "utf-8");
          const truncated = truncateHead(content, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          let text = truncated.content;
          if (truncated.truncated) {
            text += `\n\n[Output truncated. Full skill at: ${skill.filePath}]`;
          }
          results.push(`╌╌ ${skill.name} ╌╌\n\n${text}`);
        } catch (err) {
          errors.push(`"${rawName}": ${(err as Error).message}`);
        }
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No skills loaded. ${errors.join("; ")}. Available: ${availableNames.join(", ") || "(none)"}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const output = results.join("\n\n");
      const errorNote = errors.length > 0 ? `\n\n(Errors: ${errors.join("; ")})` : "";

      return {
        content: [{ type: "text", text: output + errorNote }],
        details: {
          loaded: results.length,
          loadedNames: allNames.filter((n) => results.some((r) => r.startsWith(`╌╌ ${n} ╌╌`))),
          errors: errors.length,
        },
      };
    },

    // ── Custom rendering: don't log full skill content in TUI ────────
    renderResult(result, _options, theme, _context) {
      const d = (result.details ?? {}) as Record<string, unknown>;
      let label: string;
      if ("skills" in d && Array.isArray(d.skills)) {
        label = theme.fg("dim", `${d.skills.length} skill(s) available`);
      } else if ("loaded" in d) {
        const names = Array.isArray(d.loadedNames) ? d.loadedNames : [];
        const namesStr = names.length > 0 ? `: ${names.join(", ")}` : "";
        label = theme.fg("accent", theme.bold(`Loaded ${d.loaded} skill${d.loaded === 1 ? "" : "s"}${namesStr}`));
        if ((d.errors as number ?? 0) > 0) {
          label += " " + theme.fg("warning", `(${d.errors} error(s))`);
        }
      } else {
        label = theme.fg("warning", "Skill not found");
      }
      return new Text(label, 0, 0);
    },
  });

  // ── reorder_skills tool ─────────────────────────────────────────────────
  pi.registerTool({
    name: "reorder_skills",
    label: "Reorder Skills",
    description:
      "View or change the order skills appear in. Call with list=true to " +
      "see the current order, or provide a names array to set a new order. " +
      "Skills not in the list appear at the end in their default order.",
    promptSnippet: "View or change skill display order",
    promptGuidelines: [
      "Use reorder_skills(list=true) to see the current skill order.",
      'Use reorder_skills(names=["skill-a", "skill-b"]) to set a custom order.',
      "Skills not listed in the order array appear after the ordered ones.",
    ],
    parameters: Type.Object({
      list: Type.Optional(
        Type.Boolean({
          description: "If true, show the current skill order.",
        }),
      ),
      names: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Array of skill names in desired display order. Unknown names are ignored.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.list) {
        const order = loadOrder();
        const allNames = skillsList.map((s) => s.name);
        if (order.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No custom order set. Skills appear in their default order.\n" +
                  `Available: ${allNames.join(", ")}\n\n` +
                  'Use reorder_skills(names=[...]) to set a custom order.',
              },
            ],
            details: { order: null, available: allNames },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                "Current skill order:\n" +
                order.map((n, i) => `${i + 1}. ${n}`).join("\n") +
                "\n\n" +
                'Use reorder_skills(names=[...]) to change it.',
            },
          ],
          details: { order, available: allNames },
        };
      }

      if (params.names) {
        // Validate: warn about unknown names but still save
        const known = new Set(skillsList.map((s) => s.name));
        const unknown = params.names.filter((n) => !known.has(n));
        const valid = params.names.filter((n) => known.has(n));

        // Preserve order of known names, keep unknown entries at their relative positions
        // (they'll be ignored at display time but the order indexing stays stable)
        saveOrder(params.names);

        // Refresh skillsList for the current session
        const order = loadOrder();
        skillsList = applyOrder(skillsList, order);

        let msg: string;
        if (valid.length === 0) {
          msg = "No valid skill names provided. Order unchanged.";
        } else {
          msg = `Skill order updated:\n${valid.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
        }
        if (unknown.length > 0) {
          msg += `\n\n(Unknown names ignored: ${unknown.join(", ")})`;
        }

        return {
          content: [{ type: "text", text: msg }],
          details: { order: params.names },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              "Use reorder_skills(list=true) to see current order, or " +
              'reorder_skills(names=["skill-a", "skill-b"]) to set a new one.',
          },
        ],
        details: {},
      };
    },
  });

  // ── /skills command ─────────────────────────────────────────────────────
  pi.registerCommand("skills", {
    description: "List skills or reorder them. /skills reorder <name1> <name2> ...",
    handler: async (args, _ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "reorder" && parts.length > 1) {
        const names = parts.slice(1);
        saveOrder(names);
        _ctx.ui.notify(`Skill order saved (${names.length} skills)`, "info");
        return;
      }

      // Default: show the list
      const order = loadOrderSync();
      const allNames = skillsList.map((s) => s.name);

      if (order.length === 0) {
        _ctx.ui.notify(
          `Skills: ${allNames.join(", ")}\n` +
            'Use /skills reorder <name1> <name2> ... to set order.',
          "info",
        );
      } else {
        _ctx.ui.notify(
          `Skills order: ${order.join(" → ")}\n` +
            `(Available: ${allNames.join(", ")})`,
          "info",
        );
      }
    },
  });
}
