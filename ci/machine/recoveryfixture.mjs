#!/usr/bin/env node
// The committed subset of the fault survey that the recovery catalogue (recoverycatalogue.mjs) relies on, so the quick tier can validate it without the 3.7 MB results file and without the chip engine.
//
//   node ci/machine/recoveryfixture.mjs            check that ci/machine/fixtures/recovery-survey-rows.json is exactly what docs/dev/fault-survey.json yields (exit 1 if not)
//   node ci/machine/recoveryfixture.mjs --write    regenerate it
//
// The fixture is derived, never hand-edited: the rows are copied byte for byte (as JSON) from the survey, so a regenerated survey that changes any of them fails the check until the
// catalogue's expectations and the fixture are updated together, deliberately.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogueRowIds, catalogueUnits } from "./recoverycatalogue.mjs";

export const FIXTURE_VERSION = 1;
export const SURVEY_PATH = resolve(import.meta.dirname, "../../docs/dev/fault-survey.json");
export const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/recovery-survey-rows.json");
const BOUNDING = ["old", "new", "ff"];

/** The group a row belongs to: the same cycle, the same point, every policy. The id is `unit/.../point/policy`. */
const groupOf = (id) => id.slice(0, id.lastIndexOf("/"));

/** Pure: the fixture for a parsed survey. The catalogue's rows, plus their old/new/ff siblings (the bounds each is read against), plus the controls of the units the corruption scenarios compare with. */
export function buildFixture(survey) {
  const wanted = catalogueRowIds();
  const byId = new Map(survey.rows.map((r) => [r.id, r]));
  for (const id of wanted) if (!byId.has(id)) throw new Error(`survey row ${id} is not in the survey`);
  const groups = new Set(wanted.map(groupOf));
  const keep = survey.rows.filter((r) => wanted.includes(r.id) || (groups.has(groupOf(r.id)) && BOUNDING.includes(r.id.slice(r.id.lastIndexOf("/") + 1))));
  const units = {};
  for (const u of catalogueUnits()) {
    if (!survey.units[u]) throw new Error(`survey unit ${u} is not in the survey`);
    units[u] = { controls: survey.units[u].controls };
  }
  return {
    version: FIXTURE_VERSION,
    source: "docs/dev/fault-survey.json",
    note: "Derived by ci/machine/recoveryfixture.mjs from the committed fault survey; never edit by hand. Synthetic test input, not a prediction of the physical chip.",
    surveyVersion: survey.version, disclaimer: survey.disclaimer, engine: survey.engine, surveyConfig: { chips: survey.config.chips, timing: survey.config.timing, rebootMs: survey.config.rebootMs, inputs: survey.config.inputs },
    units, rows: keep,
  };
}

export const serialize = (fixture) => JSON.stringify(fixture, null, 1) + "\n";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = buildFixture(JSON.parse(readFileSync(SURVEY_PATH, "utf8")));
  const text = serialize(fixture);
  if (process.argv.includes("--write")) {
    mkdirSync(resolve(FIXTURE_PATH, ".."), { recursive: true });
    writeFileSync(FIXTURE_PATH, text);
    console.log(`wrote ${FIXTURE_PATH}: ${fixture.rows.length} rows, ${Object.keys(fixture.units).length} units, ${text.length} bytes`);
  } else {
    const have = readFileSync(FIXTURE_PATH, "utf8").replace(/\r\n/g, "\n");     // a checkout may convert line endings
    if (have !== text) { console.error("the committed fixture differs from what the survey yields: run with --write"); process.exit(1); }
    console.log(`the fixture matches the survey (${fixture.rows.length} rows)`);
  }
}
