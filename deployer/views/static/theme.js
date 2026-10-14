// HeroUI's theme variables switch on <html data-theme>. Follow the system's light
// or dark setting until someone flips the header's toggle; that choice is kept in
// this browser. Loaded in <head>, before the page paints.
(() => {
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const read = () => {
    try {
      const saved = localStorage.getItem("theme");
      return saved === "light" || saved === "dark" ? saved : null;
    } catch {
      return null; // storage blocked: just follow the system
    }
  };
  let choice = read();
  const apply = () => (root.dataset.theme = choice ?? (dark.matches ? "dark" : "light"));
  apply();
  dark.addEventListener("change", apply);
  // Another tab flipped the toggle.
  addEventListener("storage", (event) => {
    if (event.key === "theme") {
      choice = read();
      apply();
    }
  });
  // The button is in the page body, which doesn't exist yet when this runs.
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-theme-toggle]")) return;
    choice = root.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("theme", choice);
    } catch {
      // Not remembered, but still applied to this page.
    }
    apply();
  });
})();
