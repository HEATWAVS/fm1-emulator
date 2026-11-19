// The top bar's test-mode badge ("OLDER CHIP (Puya): test mode, nothing saved") is a shortcut: clicking it opens the Flash chip box (if it was folded away) and scrolls it into view.
// The section's markup and ids are in index.html and chiptest.js wires them (the badge's text and visibility too); this file only handles the click.
// It stores nothing: not whether the section was used, and nothing about the emulation mode.
(function () {
  "use strict";
  const badge = document.getElementById("test-badge");
  if (!badge) return;
  badge.addEventListener("click", () => {
    const box = document.getElementById("chip-box");
    if (!box) return;
    // the side panels can be hidden by the layout controls: say so instead of doing nothing
    if (!box.offsetParent) { badge.title = "The left sidebar is hidden: show it from the layout controls to see the Flash chip box."; return; }
    if (box.classList.contains("lay-boxoff")) box.querySelector(".lay-boxbar button")?.click();   // the box's own fold button (layout.js)
    box.scrollIntoView({ block: "start" });
    box.querySelector('#chip-seg [aria-checked="true"]')?.focus({ preventScroll: true });
  });
})();
