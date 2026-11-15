#!/usr/bin/env node
// Structural facts about the boot head of every catalogue package (Component 7, Stage 7A). EVIDENCE LEVEL: PACKAGE: what the packages contain, nothing about what hardware does with it.
//
//   node ci/machine/bootareafacts.mjs            check that ci/machine/fixtures/bootarea-facts.json is exactly what the catalogue yields (exit 1 if not)
//   node ci/machine/bootareafacts.mjs --write    regenerate it
//
// No firmware bytes are stored: only offsets, sizes, counts, validity of the CRC-16 fields (which tells that a package is self-consistent, NOT that anything checks it) and
// 8-hex-digit SHA-256 prefixes that tell variants apart.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EMULATOR_DIR } from "./engine.mjs";
import { rawFlash, unmask, crc16, head, le16, le32, chipKey } from "./fwscport.mjs";

export const FACTS_VERSION = 1;
export const FACTS_PATH = resolve(import.meta.dirname, "fixtures/bootarea-facts.json");
const sha8 = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 8);
const tally = (map, key, extra = {}) => { const e = map.get(key) ?? { ...extra, packages: 0 }; e.packages++; map.set(key, e); };

/** Pure: the facts for a list of package byte arrays. */
export function bootAreaFacts(packages) {
  const headers = new Map(), layouts = new Map(), bodies = new Map(), configs = new Map(), gaps = new Map(), lengths = new Map();
  let crcChecks = { headerOk: 0, headsAllOk: 0, configBlobOk: 0 }, reaches = 0, parsed = 0;
  for (const pkg of packages) {
    const raw = rawFlash(pkg);
    parsed++;
    const h = raw.slice(0, 32);
    unmask(h, 0, 32, 0xffff);
    if (crc16(h, 2, 30) === le16(h, 0)) crcChecks.headerOk++;
    tally(headers, sha8(raw.subarray(0, 32)));
    const heads = [];
    let allOk = true;
    for (let o = 32; o + 32 <= 0x4000; o += 32) {
      const g = raw.slice(o, o + 32);
      unmask(g, 0, 32, 0xffff);
      allOk &&= crc16(g, 2, 30) === le16(g, 0);
      const x = head(g, 0);
      heads.push({ name: x.name, offset: x.offset, size: x.size, flags: x.flags, last: x.last });
      if (x.last) break;
    }
    if (allOk) crcChecks.headsAllOk++;
    tally(layouts, JSON.stringify(heads), { heads });
    const ub = heads.find((x) => x.name === "uboot.boot"), cfg = heads.find((x) => x.name === "isd_config.ini");
    tally(bodies, `${sha8(raw.subarray(ub.offset, ub.offset + ub.size))}:${ub.size}`, { sha8: sha8(raw.subarray(ub.offset, ub.offset + ub.size)), size: ub.size, offset: ub.offset });
    const blob = raw.subarray(cfg.offset, cfg.offset + 32);
    const blobOk = crc16(raw, cfg.offset, 32) === le16(raw, cfg.offset + 32);
    if (blobOk) crcChecks.configBlobOk++;
    tally(configs, `${sha8(raw.subarray(cfg.offset, cfg.offset + cfg.size))}`, { entrySha8: sha8(raw.subarray(cfg.offset, cfg.offset + cfg.size)), entrySize: cfg.size, blobSha8: sha8(blob), derivedKey: chipKey(blob), blobCrcOk: blobOk });
    const gapStart = cfg.offset + cfg.size;
    let ff = true;
    for (let a = gapStart; a < 0x4000; a++) if (raw[a] !== 0xff) { ff = false; break; }
    tally(gaps, `${gapStart}:${ff}`, { start: gapStart, end: 0x4000, allFF: ff });
    tally(lengths, raw.length, { flashImageBytes: raw.length });
    if (raw.length > 0xff000) reaches++;
  }
  const list = (m, key) => [...m.values()].sort((a, b) => b.packages - a.packages || String(a[key] ?? "").localeCompare(String(b[key] ?? "")));
  return {
    version: FACTS_VERSION,
    evidenceLevel: "PACKAGE",
    note: "Structural facts about the catalogue's boot heads. CRC validity shows self-consistency of the packages, NOT that the mask ROM, the SPL or the emulator checks it. No firmware bytes are stored.",
    packages: parsed,
    crcFieldsValid: crcChecks,
    imagesReachingKeySector: reaches,
    layout: { headerBytes: "[0,0x20)", directoryHeadsFrom: 0x20, headBytes: 32, appAreaOffset: 0x4000, keySectorOffset: 0xff000 },
    rawHeaderVariants: list(headers, "packages").map((v, i) => ({ variant: i, ...v })),
    directoryLayouts: list(layouts, "packages"),
    ubootBodies: list(bodies, "size"),
    isdConfigEntries: list(configs, "blobSha8"),
    gapAfterConfigEntry: list(gaps, "start"),
    flashImageLengths: list(lengths, "flashImageBytes"),
  };
}

export const serialize = (facts) => JSON.stringify(facts, null, 1) + "\n";
export function cataloguePackages() {
  return JSON.parse(readFileSync(resolve(EMULATOR_DIR, "firmwares.json"), "utf8")).firmwares.filter((e) => e.package).map((e) => new Uint8Array(readFileSync(resolve(EMULATOR_DIR, e.package))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const text = serialize(bootAreaFacts(cataloguePackages()));
  if (process.argv.includes("--write")) {
    mkdirSync(resolve(FACTS_PATH, ".."), { recursive: true });
    writeFileSync(FACTS_PATH, text);
    console.log(`wrote ${FACTS_PATH}: ${text.length} bytes`);
  } else if (readFileSync(FACTS_PATH, "utf8").replace(/\r\n/g, "\n") !== text) { console.error("the committed facts differ from what the catalogue yields: run with --write"); process.exit(1); }
  else console.log("the facts match the catalogue");
}
