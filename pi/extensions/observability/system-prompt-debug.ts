/**
 * System Prompt Debug
 *
 * Captures the final provider request sent to the LLM. View or copy with
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
  pi.on("before_provider_request", (event) => {
    captured = JSON.stringify(event.payload, null, 2);
  });

  pi.registerCommand("sysprompt", {
    description: "View the last captured provider payload. /sysprompt copy to copy it.",
    handler: async (args, ctx) => {
      if (!captured) {
        ctx.ui.notify("No provider request captured. Send a prompt first.", "warning");
        return;
      }

      const prompt = captured;

      if (args === "copy") {
        try {
          execSync("pbcopy", { input: prompt });
          ctx.ui.notify(`✓ Provider payload (${prompt.length} chars) copied`, "info");
        } catch {
          ctx.ui.notify("Failed to copy", "error");
        }
        return;
      }

      const label = `Provider Payload (${prompt.length} chars) — select & copy, or Escape to close`;

      await ctx.ui.editor(label, prompt);
    },
  });
}
