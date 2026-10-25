// What the preview pages share: the wallet data they draw from, the theme the review page asks for, and ?shot,
// which holds a state still for a picture of it.

const FIXTURES = new URL("./fixtures.json", import.meta.url);

/** The wallet data fixtures.mjs read, or null when it hasn't been run in this checkout. */
export const readFixtures = () => fetch(FIXTURES).then((r) => (r.ok ? r.json() : null)).catch(() => null);

/** The same, for a page that can't do without it: until it's there, the page says how to read it, and goes no further. */
export async function needFixtures() {
  const fixtures = await readFixtures();
  if (fixtures) return fixtures;
  document.body.innerHTML = `<p class="missing">No wallet read yet. Read one, then reload: <code>node scripts/preview/fixtures.mjs &lt;wallet&gt;</code></p>`;
  return new Promise(() => {});
}

/** The page in `theme`, light or dark, whatever this computer's appearance, again whenever Vite swaps the styles. */
export function forceTheme(theme) {
  const apply = () => {
    // a browser that already prefers it is left alone: Edge 156 drops inherited colours under rules rewritten here,
    // so a dark picture on Windows comes from an Edge that prefers dark, as capture.mjs asks of it
    if (matchMedia("(prefers-color-scheme: dark)").matches === (theme === "dark")) return;
    document.documentElement.style.colorScheme = theme;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-color-scheme")) rule.media.mediaText = rule.conditionText.includes("dark") === (theme === "dark") ? "all" : "not all";
      }
    }
  };
  new MutationObserver(apply).observe(document.head, { childList: true, subtree: true, characterData: true });
  apply();
}

/**
 * ?shot: the state held still for a picture. Every animation ends as it starts, so a capture never lands half way
 * through one, and the page reads as out of sight, so what moves on a timer while it's seen, as the swarm's line,
 * stays on its first. And inside `root`, an element computed pure black, which neither theme uses, takes its
 * parent's colour, parents first: Edge 156 drops inherited colours on nodes added after its first full restyle.
 */
export function holdStill(root) {
  Object.defineProperty(document, "hidden", { value: true });
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    try { animation.finish(); } catch {}
    return animation;
  };
  const still = document.createElement("style");
  still.textContent = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }";
  document.head.append(still);
  const repair = () => {
    for (const el of root.querySelectorAll("*")) {
      if (getComputedStyle(el).color === "rgb(0, 0, 0)") el.style.color = getComputedStyle(el.parentElement).color;
    }
  };
  new MutationObserver(repair).observe(root, { childList: true, subtree: true, characterData: true });
  setInterval(repair, 200);
}

/** Says the state has been reached, past what was pressed to get there: capture.mjs waits for it. */
export const ready = () => {
  document.documentElement.dataset.ready = "";
};
