import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OVERRIDE_FILE_NAME = "AGENTS.override.md";
const MANAGED_OVERRIDE_CONTENT = "<!-- Managed by /claude-md-ignore. -->\n";

type OverrideState = "absent" | "managed" | "existing";

async function readOverrideState(overridePath: string): Promise<OverrideState> {
  try {
    const content = await readFile(overridePath, "utf8");
    return content === MANAGED_OVERRIDE_CONTENT ? "managed" : "existing";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function describeState(state: OverrideState): string {
  if (state === "managed") return "CLAUDE.md is ignored in this directory.";
  if (state === "existing") {
    return "An existing AGENTS.override.md controls context in this directory.";
  }
  return "CLAUDE.md loads normally in this directory.";
}

async function enableOverride(overridePath: string): Promise<string | undefined> {
  const state = await readOverrideState(overridePath);

  if (state === "managed") return "CLAUDE.md is already ignored in this directory.";
  if (state === "existing") {
    return "Refusing to replace the existing AGENTS.override.md.";
  }

  try {
    await writeFile(overridePath, MANAGED_OVERRIDE_CONTENT, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "Refusing to replace the existing AGENTS.override.md.";
    }
    throw error;
  }

  return undefined;
}

async function disableOverride(overridePath: string): Promise<string | undefined> {
  const state = await readOverrideState(overridePath);

  if (state === "absent") return "CLAUDE.md already loads normally in this directory.";
  if (state === "existing") {
    return "Refusing to remove the existing AGENTS.override.md.";
  }

  await unlink(overridePath);
  return undefined;
}

export default function contextFilesExtension(pi: ExtensionAPI): void {
  pi.registerCommand("claude-md-ignore", {
    description: "Toggle CLAUDE.md loading in the current directory",
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      const overridePath = join(ctx.cwd, OVERRIDE_FILE_NAME);
      const currentState = await readOverrideState(overridePath);

      if (argument === "status") {
        ctx.ui.notify(describeState(currentState), "info");
        return;
      }

      const shouldEnable = argument === "on" || (!argument && currentState !== "managed");
      const shouldDisable = argument === "off" || (!argument && currentState === "managed");

      if (!shouldEnable && !shouldDisable) {
        ctx.ui.notify("Usage: /claude-md-ignore [on|off|status]", "warning");
        return;
      }

      const result = shouldEnable
        ? await enableOverride(overridePath)
        : await disableOverride(overridePath);

      if (result) {
        ctx.ui.notify(result, "warning");
        return;
      }

      ctx.ui.notify("Reloading context files...", "info");
      await ctx.reload();
    },
  });
}
