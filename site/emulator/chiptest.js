// The "Flash chip test" panel (Component 8, Stage 2): the emulation mode select, the copyable diagnostic report and the comparison of the original engine with the
// two flash-chip profiles. The pure parts (modes, report text, comparison) are chipmode.js and chipcompare.js; this file is the page wiring and is covered by
// ci/chip-mode-tests.mjs only as far as a script can (the pure modules, the engine boot path and the saving rules); the buttons themselves were exercised in the browser pane.
import { MODES, TIMINGS, modeById, modeFromParam, buildReport } from "./chipmode.js?v=1";
import { changedSectorList } from "./chipcompare.js?v=1";

const COMPARE_SECONDS = 3;

/**
 * ctx: params (URLSearchParams); engineBytesFor(mode) -> Promise<ArrayBuffer>; packageOf(fw) -> Promise<{bytes}>; packageHash(bytes) -> Promise<hex>;
 * state() -> { fw, mhz, jit, running, engine }; reboot(); flush().
 * Returns { mode(), timing(), notePackage(p), onWorkletMessage(m) } for main.js.
 */
export function initChipTest(ctx) {
  const $ = (id) => document.getElementById(id);
  const sel = $("chipmode");
  let mode = modeFromParam(ctx.params.get("mode")), timing = TIMINGS.some((t) => t.id === ctx.params.get("chiptiming")) ? ctx.params.get("chiptiming") : "typical";
  let lastPackage = null, comparison = null, request = 0, comparing = false;
  const waiters = new Map();
  const api = { mode: () => mode, timing: () => timing, notePackage: (p) => { lastPackage = p; comparison = null; }, onWorkletMessage: (m) => {
    const w = waiters.get(m.request);
    if (w) { waiters.delete(m.request); clearTimeout(w.timer); w.resolve(m); }
  } };
  if (!sel) return api;                                               // a page without the panel (the embedded player) keeps the default

  const timingSel = $("chiptiming"), timingRow = $("chiptiming-row"), note = $("chipnote"), copyBtn = $("chip-copy"), cmpBtn = $("chip-compare"), stat = $("chip-status"),
    outWrap = $("chip-report-wrap"), out = $("chip-report");
  for (const m of MODES) sel.add(new Option(m.label, m.id));
  for (const t of TIMINGS) timingSel.add(new Option(t.label, t.id));
  sel.value = mode.id;
  timingSel.value = timing;
  const refresh = () => {
    note.textContent = mode.note;
    timingRow.hidden = !mode.chip;
    document.body.dataset.chipMode = mode.id;
  };
  refresh();
  const setStatus = (text, error = false) => { stat.textContent = text; stat.dataset.error = String(error); };
  sel.addEventListener("change", () => {
    mode = modeById(sel.value) ?? mode;
    refresh();
    sel.blur();
    setStatus(mode.test ? `${mode.label}: the firmware restarts in this mode` : "Default: the firmware restarts as it always ran");
    ctx.reboot();
  });
  timingSel.addEventListener("change", () => { timing = timingSel.value; timingSel.blur(); if (mode.chip) ctx.reboot(); });

  const askStatus = (engine) => new Promise((resolve) => {
    const id = ++request;
    const timer = setTimeout(() => { waiters.delete(id); resolve(null); }, 3000);
    waiters.set(id, { resolve, timer });
    engine.postMessage({ type: "chip-status", request: id });
  });

  async function engineIdentity(m) {
    const bytes = await ctx.engineBytesFor(m);
    let sha256 = null;
    try { sha256 = await ctx.packageHash(bytes); } catch { /* no SubtleCrypto: the hash is left out, not invented */ }
    return { file: m.engine === "unified" ? "fm1_web_unified.wasm" : "fm1_web.wasm", sha256 };
  }

  async function gather() {
    const s = ctx.state();
    const live = s.running && s.engine ? await askStatus(s.engine) : null;
    const session = s.running;
    if (session?.ephemeral) { try { await ctx.flush(); } catch { /* the latest snapshot already held is used */ } }
    const sectors = session?.base && session?.flash ? changedSectorList(session.base, session.flash) : null;
    const m = session?.mode ?? mode;
    return buildReport({
      generated: new Date().toISOString(),
      app: { name: "FM-1 Emulator" },
      mode: m, timing: session?.timing ?? timing,
      engine: await engineIdentity(m),
      firmware: { id: lastPackage?.id ?? s.fw?.id, name: lastPackage?.name ?? s.fw?.name, sha256: lastPackage?.hash ?? null },
      run: live ? { mhz: s.mhz, jit: s.jit, board: live.board, status: live.status } : null,
      sectors: sectors ? { count: sectors.length, list: sectors } : null,
      comparison,
    });
  }

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

  const show = (text) => { out.textContent = text; outWrap.hidden = false; };
  copyBtn.addEventListener("click", async () => {
    copyBtn.disabled = true;
    try {
      const text = await gather();
      show(text);
      setStatus((await copyText(text)) ? "Report copied. Paste it into a message or an issue." : "Could not use the clipboard: the report is shown below, select it and copy.", false);
    } catch (error) { setStatus(`Could not build the report: ${error?.message ?? error}`, true); }
    finally { copyBtn.disabled = false; }
  });

  cmpBtn.addEventListener("click", async () => {
    if (comparing) return;
    const s = ctx.state();
    comparing = true; cmpBtn.disabled = true;
    try {
      if (s.running?.board === 1 || s.fw?.board === 1) throw new Error("the chip profiles are for the FM-1 board; SMK-37 firmware cannot be compared");
      setStatus("Comparing: loading the package…");
      const pkg = lastPackage && lastPackage.id === s.fw?.id ? lastPackage : { ...(await ctx.packageOf(s.fw)), id: s.fw?.id, name: s.fw?.name };
      const shipped = await ctx.engineBytesFor(modeById("default")), unified = await ctx.engineBytesFor(modeById("puya"));
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker("chipcompare-worker.js?v=1", { type: "module" });
        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "the comparison worker failed")); };
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === "progress") setStatus(`Comparing ${m.text} (${COMPARE_SECONDS} s of emulated time each)…`);
          else if (m.type === "done") { worker.terminate(); resolve(m.result); }
          else if (m.type === "error") { worker.terminate(); reject(new Error(m.message)); }
        };
        const bytes = pkg.bytes instanceof Uint8Array ? pkg.bytes : new Uint8Array(pkg.bytes);
        worker.postMessage({ type: "compare", shipped: shipped.slice(0), unified: unified.slice(0), package: bytes.slice().buffer, mhz: s.mhz, seconds: COMPARE_SECONDS, timing });
      });
      comparison = result;
      const n = result.differences.length;
      setStatus(n ? `Compared: ${n} difference(s) between the configurations. Copy report includes them.` : "Compared: no difference seen in what was compared. Copy report includes the details.", false);
      show(await gather());
    } catch (error) { setStatus(`Comparison failed: ${error?.message ?? error}`, true); }
    finally { comparing = false; cmpBtn.disabled = false; }
  });

  return api;
}
