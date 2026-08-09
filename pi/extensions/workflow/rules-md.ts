import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
]);

function projectRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

function findRulesFiles(dir: string): string[] {
  const files: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name.startsWith(".") ||
        SKIPPED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      files.push(...findRulesFiles(entryPath));
    } else if (entry.isFile() && entry.name === "RULES.md") {
      files.push(entryPath);
    }
  }

  return files;
}

function loadRules(root: string): string {
  return findRulesFiles(root)
    .sort()
    .map((filePath) => {
      try {
        const relativePath = path.relative(root, filePath) || "RULES.md";
        const contents = fs.readFileSync(filePath, "utf8").trim();
        return contents ? `### ${relativePath}\n\n${contents}` : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((rule): rule is string => rule !== undefined)
    .join("\n\n");
}

export default function rulesMdExtension(pi: ExtensionAPI) {
  let rules = "";

  pi.on("session_start", (_event, ctx) => {
    rules = loadRules(projectRoot(ctx.cwd));
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!rules) {
      rules = loadRules(projectRoot(ctx.cwd));
    }
    if (!rules) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Project Rules\n\n${rules}`,
    };
  });
}
