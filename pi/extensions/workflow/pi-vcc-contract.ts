/**
 * pi-vcc is installed as its own Pi package (see `packages` in pi/settings.json),
 * so this contract is shared by convention only, not by import:
 *
 * - `PI_VCC_COMPACT_INSTRUCTION` is passed as `customInstructions` to
 *   `ctx.compact()`. pi-vcc's `session_before_compact` hook matches it to claim
 *   the compaction instead of letting Pi summarize with its own model.
 * - `PI_VCC_COMPACTOR` is the tag pi-vcc writes to `compaction.details.compactor`,
 *   used here to confirm pi-vcc actually handled a compaction.
 *
 * Pi forbids one package resolving another package's internals ("Installed
 * packages load with separate module roots. Do not rely on two packages sharing
 * one dependency instance or one package resolving another package's undeclared
 * dependency." - Pi docs/packages.md), so these literals cannot be imported.
 */
export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";
export const PI_VCC_COMPACTOR = "pi-vcc";
