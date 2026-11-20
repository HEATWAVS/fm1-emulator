// The "Flash chip" box under Now running (Component 8, Stage 2): the three chip buttons (Default, Older, Newer: picking one restarts the firmware on that chip; a hidden #chipmode select is the source of truth), what the chip does, the warning, and the comparison of the two flash-chip profiles (the previous shipped
// engine and the original flash model run as controls) with its verdict card and its copyable report in an always-visible report area. The pure parts (modes, report text, comparison) are chipmode.js and chipcompare.js; this file is the page wiring and is covered by
// ci/chip-mode-tests.mjs only as far as a script can (the pure modules, the engine boot path and the saving rules); the buttons themselves were exercised in the browser pane.
import { MODES, TIMINGS, modeById, modeFromParam, buildReport, pll0Entry, panelNotice, countChipIds, classifyChipIds, withCodeCheck, CODE_CHECK_NOTE } from "./chipmode.js?v=15";
import { appFromPackage } from "./fwsc.js";

const COMPARE_SECONDS = 3;

/**
 * ctx: params (URLSearchParams); engineBytesFor(mode) -> Promise<ArrayBuffer>; packageOf(fw) -> Promise<{bytes}>; packageHash(bytes) -> Promise<hex>;
 * state() -> { fw, mhz, running }; reboot().
 * Returns { mode(), timing(), notePackage(p), onWorkletMessage(m) } for main.js.
 */
export function initChipTest(ctx) {
  const $ = (id) => document.getElementById(id);
  const sel = $("chipmode");
  let mode = modeFromParam(ctx.params.get("mode")), timing = TIMINGS.some((t) => t.id === ctx.params.get("chiptiming")) ? ctx.params.get("chiptiming") : "typical";
  let lastPackage = null, comparison = null, comparing = false;
  let onPackage = () => {};
  let renderVerdictLater = () => {};
  const api = { mode: () => mode, timing: () => timing, notePackage: (p) => { lastPackage = p; comparison = null; renderVerdictLater(); onPackage(); }, onWorkletMessage: () => {} };   // the page no longer asks the engine for chip status: the report is the comparison's
  if (!sel) return api;                                               // a page without the panel (the embedded player) keeps the default

  const timingSel = $("chiptiming"), timingRow = $("chip-timing-wrap"), note = $("chipnote"), notice = $("chip-notice"), copyBtn = $("chip-copy"), cmpBtn = $("chip-compare"), stat = $("chip-status"), cmpStat = $("chip-cmp-status"), out = $("chip-report");
  // the select lists Default and the two chips; a hidden reference mode (reached with ?mode=) is added only while it is the one running, so the select never shows a mode it is not in
  for (const m of MODES) if (!m.hidden || m === mode) sel.add(new Option(m.label, m.id));
  for (const t of TIMINGS) timingSel.add(new Option(t.label, t.id));
  sel.value = mode.id;
  timingSel.value = timing;
  // The PLL0 list (site/emulator/pll0-firmware.json): the firmware whose audio engine starts on the unified engine and never on the previous shipped engine, matched by package SHA-256 only.
  let pll0 = null;
  const hashOfLoaded = () => {
    const s = ctx.state();
    return lastPackage && lastPackage.id === s.fw?.id ? lastPackage.hash : s.fw?.sha256 ?? null;      // the booted package's hash; else the catalogue's for the selected firmware
  };
  const refreshNotice = () => {
    const text = panelNotice({ mode, entry: pll0Entry(hashOfLoaded(), pll0) });
    notice.textContent = text ?? "";
    notice.hidden = !text;
  };
  // the three chip buttons (a hidden reference mode, reached with ?mode=, gets a fourth button while it is the one running). A radio group: arrows move and select, so the keyboard works.
  const seg = $("chip-seg");
  const buttons = [];
  for (const m of MODES) {
    if (m.hidden && m !== mode) continue;
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "radio"); b.dataset.mode = m.id; b.textContent = m.short ?? m.label; b.title = m.label;
    b.addEventListener("click", () => choose(m.id));
    b.addEventListener("keydown", (e) => {
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const next = buttons[(buttons.indexOf(b) + dir + buttons.length) % buttons.length];
      next.focus(); choose(next.dataset.mode);
    });
    buttons.push(b); seg?.append(b);
  }
  const choose = (id) => { if (id === mode.id) return; sel.value = id; sel.dispatchEvent(new Event("change")); };
  const refresh = () => {
    note.textContent = mode.effect ?? mode.note;
    timingRow.hidden = !mode.chip;
    document.body.dataset.chipMode = mode.id;
    for (const b of buttons) { const on = b.dataset.mode === mode.id; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle("on", on); }
    const badge = $("test-badge");                                     // the top bar's badge (compat.js jumps here from it): names the chip, shown for every test mode, hidden for Default
    if (badge) { badge.hidden = !mode.test; badge.textContent = mode.badge || "TEST MODE: nothing is saved"; }
    refreshNotice();
  };
  onPackage = refreshNotice;
  refresh();
  fetch("pll0-firmware.json?v=1").then((r) => (r.ok ? r.json() : null)).then((d) => { pll0 = d; refreshNotice(); }).catch(() => { pll0 = null; });
  document.addEventListener("fm1-fw-selected", refreshNotice);
  const setStatus = (text, error = false) => { stat.textContent = text; stat.dataset.error = String(error); };
  sel.addEventListener("change", () => {
    mode = modeById(sel.value) ?? mode;
    refresh();
    sel.blur();
    setStatus(mode.restarted ?? `Restarted in ${mode.short ?? mode.label} mode`);
    ctx.reboot();
  });
  timingSel.addEventListener("change", () => { timing = timingSel.value; timingSel.blur(); if (mode.chip) ctx.reboot(); });

  // the plain-language verdict card of a comparison (text only, built with textContent; always on the page, back to its one-line placeholder when another firmware loads)
  const verdictBox = $("chip-verdict");
  const VERDICT_PLACEHOLDER = "The verdict appears here after you compare the chips.";
  renderVerdictLater = () => { renderVerdict(null); clearReport(); };
  const renderVerdict = (v) => {
    if (!verdictBox) return;
    verdictBox.replaceChildren();
    const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; verdictBox.append(e); return e; };
    if (!v) { delete verdictBox.dataset.tone; delete verdictBox.dataset.key; verdictBox.dataset.empty = "true"; add("p", "chip-vempty", VERDICT_PLACEHOLDER); return; }   // the card is always there: before a comparison it says what it is for
    delete verdictBox.dataset.empty;
    verdictBox.dataset.tone = v.tone; verdictBox.dataset.key = v.key;
    add("p", "chip-vh", v.headline);
    add("p", "chip-vl", "What it means"); add("p", "chip-vt", v.meaning);
    if (v.reasons) { add("p", "chip-vl", "Possible reasons"); add("p", "chip-vt", v.reasons); }
    add("p", "chip-vl", "What to try"); add("p", "chip-vt", v.next);
    if (v.code) { add("p", "chip-vl", "Code check"); add("p", "chip-vt", v.code.text); add("p", "chip-vfine", CODE_CHECK_NOTE); }
    const rows = add("p", "chip-vrows", "");
    v.rows.forEach((r, i) => { if (i) rows.append(document.createElement("br")); const sp = document.createElement("span"); sp.dataset.state = r.state; sp.textContent = r.text; rows.append(`${r.label}: `, sp); });
    add("p", "chip-vfine", v.closing);
  };
  // The report area is always on the page: a status line for everything about Compare and the report, then the report text. Copy report stays off until a comparison has produced one.
  // The mode status (#chip-status, under the chip buttons) is only about switching modes.
  const PLACEHOLDER = "The report appears here after you compare the chips.";
  const setCmpStatus = (text, error = false) => { cmpStat.textContent = text; cmpStat.dataset.error = String(error); };
  function clearReport() { out.textContent = PLACEHOLDER; copyBtn.disabled = true; setCmpStatus(""); }
  clearReport();

  const gather = () => buildReport({
    generated: new Date().toISOString(),
    firmware: { id: lastPackage?.id ?? ctx.state().fw?.id, name: lastPackage?.name ?? ctx.state().fw?.name, sha256: lastPackage?.hash ?? null },
    comparison,
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  copyBtn.addEventListener("click", async () => {
    if (!comparison) return;
    setCmpStatus((await copyText(out.textContent)) ? "Report copied. Paste it into a message or an issue." : "Could not use the clipboard: select the report and copy it.", false);
  });

  cmpBtn.addEventListener("click", async () => {
    if (comparing) return;
    const s = ctx.state();
    comparing = true; cmpBtn.disabled = true; comparison = null; renderVerdict(null); clearReport();
    $("chip-report-wrap")?.scrollIntoView({ block: "nearest" });   // the progress line is in the report area: bring it into view
    try {
      if (s.running?.board === 1 || s.fw?.board === 1) throw new Error("the chip profiles are for the FM-1 board; SMK-37 firmware cannot be compared");
      setCmpStatus("Comparing: loading the package…");
      const pkg = lastPackage && lastPackage.id === s.fw?.id ? lastPackage : { ...(await ctx.packageOf(s.fw)), id: s.fw?.id, name: s.fw?.name };
      const shipped = await ctx.engineBytesFor(modeById("previous-engine")), unified = await ctx.engineBytesFor(modeById("puya"));
      // the code check: which chip IDs the firmware's own code contains (the decoded app image; null if it cannot be read)
      let codeClass = null;
      try { codeClass = classifyChipIds(countChipIds(appFromPackage(pkg.bytes instanceof Uint8Array ? pkg.bytes : new Uint8Array(pkg.bytes)))); } catch { codeClass = null; }
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker("chipcompare-worker.js?v=15", { type: "module" });
        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "the comparison worker failed")); };
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === "progress") setCmpStatus(`Comparing… step ${m.text} (${COMPARE_SECONDS} s each)`);
          else if (m.type === "done") { worker.terminate(); resolve(m.result); }
          else if (m.type === "error") { worker.terminate(); reject(new Error(m.message)); }
        };
        const bytes = pkg.bytes instanceof Uint8Array ? pkg.bytes : new Uint8Array(pkg.bytes);
        worker.postMessage({ type: "compare", shipped: shipped.slice(0), unified: unified.slice(0), package: bytes.slice().buffer, mhz: s.mhz, seconds: COMPARE_SECONDS, timing });
      });
      comparison = result;
      result.verdict = withCodeCheck(result.verdict, codeClass);
      renderVerdict(result.verdict);
      out.textContent = gather();
      copyBtn.disabled = false;
      setCmpStatus(result.chipDifferences.length ? "Compared. The report lists the differences between the two chips." : "Compared. No difference seen between the two chips in what was compared.", false);
    } catch (error) { setCmpStatus(`Comparison failed: ${error?.message ?? error}`, true); }
    finally { comparing = false; cmpBtn.disabled = false; }
  });

  return api;
}
