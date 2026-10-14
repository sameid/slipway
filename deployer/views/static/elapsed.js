// Running jobs' times count up between page loads. The server renders each
// one's seconds so far in data-elapsed; this adds the time since the page
// loaded, so the viewer's clock doesn't matter. Formats like duration() in
// src/app.ts.
(() => {
  const els = document.querySelectorAll("[data-elapsed]");
  if (!els.length) return;
  const loaded = performance.now();
  const pad = (n) => String(n).padStart(2, "0");
  const duration = (seconds) => {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
  };
  setInterval(() => {
    const extra = (performance.now() - loaded) / 1000;
    for (const el of els) el.textContent = duration(Number(el.dataset.elapsed) + extra);
  }, 1000);
})();
