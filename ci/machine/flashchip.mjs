// Flash-chip PROFILE selection for the headless machine harness (Component 4, Stage C2).
//
// Not the same thing as flashid.mjs. flashId changes only the three JEDEC ID bytes the firmware reads, by a runtime
// patch of the shipped engine. flashChip selects a datasheet-based chip model compiled into a chip-profile engine
// (built by ci/engine/build.mjs): real status register, WEL, WIP, protection, page wrap and cycle timing for the
// Puya P25Q80H reference profile or the UC25HQ80. "legacy" (the default) is the engine's original instantaneous flash
// model, untouched. The two options are mutually exclusive unless flashChip is legacy.
//
// Chip selection happens once, while the machine is being booted, before anything has been rendered; there is no way
// to change the chip of a running machine (power-cycle with another flashChip to swap it while the unit is "off").

export class FlashChipError extends Error {
  constructor(code, message) { super(message); this.name = "FlashChipError"; this.code = code; }
}

/** The ids the engine's fm1_flash_chip(id) export takes (0 = the original model). */
export const FLASH_CHIPS = {
  legacy: { id: 0, label: "original model (instantaneous, no WIP, no protection)" },
  puya: { id: 1, label: "Puya P25Q80H reference profile (JEDEC 85 60 14)" },
  uc25hq80: { id: 2, label: "UC25HQ80 (JEDEC B3 60 14)" },
};
const CHIP_ALIASES = { legacy: "legacy", original: "legacy", puya: "puya", old: "puya", uc25hq80: "uc25hq80", new: "uc25hq80" };
/** The values fm1_flash_timing(mode) takes. */
export const FLASH_TIMINGS = { typical: 0, maximum: 1 };

/** "puya" | "uc25hq80" | "legacy" (or the aliases old / new / original), case-insensitive. Anything else is refused. */
export function parseFlashChip(input) {
  const name = typeof input === "string" ? CHIP_ALIASES[input.trim().toLowerCase()] : undefined;
  if (!name) throw new FlashChipError("invalid-chip", `unsupported flash chip ${JSON.stringify(input)}: use legacy, puya (alias old) or uc25hq80 (alias new)`);
  return name;
}

/** "typical" | "maximum" (case-insensitive). */
export function parseFlashTiming(input) {
  const name = typeof input === "string" ? input.trim().toLowerCase() : undefined;
  if (!(name in FLASH_TIMINGS)) throw new FlashChipError("invalid-timing", `unsupported flash timing ${JSON.stringify(input)}: use typical or maximum`);
  return name;
}

/**
 * Validate the three flash options together and normalise them. Returns { chip, timing } where chip is the profile name
 * ("legacy" when none was asked for) and timing is null unless a chip profile was chosen.
 * Rules: flashTiming needs a chip profile; flashId cannot be combined with a chip profile (the profile has its own ID).
 */
export function resolveFlashChipOptions({ flashChip = null, flashTiming = null, flashId = null } = {}) {
  const chip = flashChip === null || flashChip === undefined ? "legacy" : parseFlashChip(flashChip);
  const hasTiming = flashTiming !== null && flashTiming !== undefined;
  const timing = hasTiming ? parseFlashTiming(flashTiming) : null;
  const hasId = flashId !== null && flashId !== undefined;
  if (chip === "legacy" && hasTiming) throw new FlashChipError("timing-needs-chip", "flashTiming applies to a chip profile (puya or uc25hq80); the legacy model has no timing");
  if (chip !== "legacy" && hasId) throw new FlashChipError("id-conflict", `flashId and flashChip ${chip} cannot be combined: the chip profile reports its own ID`);
  return { chip, timing: chip === "legacy" ? null : timing ?? "typical" };
}

/** Select the profile on a freshly booted engine instance (before its first render). Returns what was applied. */
export function applyFlashChip(x, { chip, timing }) {
  if (chip === "legacy") return null;
  if (x.fm1_flash_chip(FLASH_CHIPS[chip].id) !== 0) throw new FlashChipError("engine-refused", `the engine refused flash chip ${chip}`);
  if (x.fm1_flash_timing(FLASH_TIMINGS[timing]) !== 0) throw new FlashChipError("engine-refused", `the engine refused flash timing ${timing}`);
  return { chip, timing, jedec: chip === "puya" ? [0x85, 0x60, 0x14] : [0xb3, 0x60, 0x14] };
}
