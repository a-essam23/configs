/**
 * System Prompt Debug
 *
 * Captures the actual system prompt sent to the LLM during agent turns
 * (after all before_agent_start extensions have run). View or copy with
 * /sysprompt.
 *
 * Commands:
 *   /sysprompt          — show the last captured prompt in an editor
 *   /sysprompt copy     — copy to clipboard
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

let captured: string | null = null;

export default function (pi: ExtensionAPI) {
  pi.on("message_start", (event) => {
    if (event.message.role !== "system") return;
    const text = event.message.content
      ?.filter((c: { type: string }) => c.type === "text")
      .map((c: { type: string; text: string }) => c.text)
      .join("\n");
    if (text) captured = text;
  });

  pi.registerCommand("sysprompt", {
    description: "View the last captured system prompt. /sysprompt copy to copy it.",
    handler: async (args, ctx) => {
      const prompt = captured ?? ctx.getSystemPrompt();

      if (args === "copy") {
        try {
          execSync("pbcopy", { input: prompt });
          ctx.ui.notify(`✓ System prompt (${prompt.length} chars) copied`, "info");
        } catch {
          ctx.ui.notify("Failed to copy", "error");
        }
        return;
      }

      const label = captured
        ? `System Prompt (${prompt.length} chars) — select & copy, or Escape to close`
        : `System Prompt — BASE (${prompt.length} chars) — send a message first for the real version`;

      await ctx.ui.editor(label, prompt);
    },
  });
}
