// The comparison off the page's thread (chiptest.js): compiles the two engines and runs chipcompare.js's runComparison. No storage, no audio device.
import { runComparison } from "./chipcompare.js?v=2";

self.onmessage = async (e) => {
  const m = e.data;
  if (m?.type !== "compare") return;
  try {
    const engines = { shipped: await WebAssembly.compile(m.shipped), unified: await WebAssembly.compile(m.unified) };
    const result = await runComparison({
      engines, pkg: new Uint8Array(m.package), mhz: m.mhz, seconds: m.seconds, timing: m.timing,
      onProgress: (text) => self.postMessage({ type: "progress", text }),
    });
    self.postMessage({ type: "done", result });
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.message ?? error) });
  }
};
