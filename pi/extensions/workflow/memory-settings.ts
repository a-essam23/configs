import * as fs from "node:fs";
import * as path from "node:path";

export interface MemorySettings {
  disabledGlobalMemoryIds: string[];
}

export interface MemorySettingsChange {
  changed: boolean;
  disabled: boolean;
}

const SETTINGS_FILE_NAME = "memory-settings.json";

export function memorySettingsFile(cwd: string): string {
  return path.join(cwd, ".pi", SETTINGS_FILE_NAME);
}

export function loadMemorySettings(cwd: string): MemorySettings {
  try {
    const filePath = memorySettingsFile(cwd);
    if (!fs.existsSync(filePath)) return { disabledGlobalMemoryIds: [] };

    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return { disabledGlobalMemoryIds: [] };

    const ids = (raw as { disabledGlobalMemoryIds?: unknown }).disabledGlobalMemoryIds;
    if (!Array.isArray(ids)) return { disabledGlobalMemoryIds: [] };

    return {
      disabledGlobalMemoryIds: [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))],
    };
  } catch {
    return { disabledGlobalMemoryIds: [] };
  }
}

function saveMemorySettings(cwd: string, settings: MemorySettings): void {
  const filePath = memorySettingsFile(cwd);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

export function isGlobalMemoryDisabled(settings: MemorySettings, memoryId: string): boolean {
  return settings.disabledGlobalMemoryIds.includes(memoryId);
}

export function setGlobalMemoryDisabled(
  cwd: string,
  memoryId: string,
  disabled: boolean,
  options: { dryRun?: boolean } = {},
): MemorySettingsChange {
  const current = loadMemorySettings(cwd);
  const currentlyDisabled = isGlobalMemoryDisabled(current, memoryId);
  if (currentlyDisabled === disabled) {
    return { changed: false, disabled };
  }

  const ids = disabled
    ? [...current.disabledGlobalMemoryIds, memoryId]
    : current.disabledGlobalMemoryIds.filter((id) => id !== memoryId);
  const settings = { disabledGlobalMemoryIds: ids };

  if (!options.dryRun) saveMemorySettings(cwd, settings);

  return { changed: true, disabled };
}
