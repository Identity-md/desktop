import { agentSvg } from "./api";

/**
 * Each agent's face, cut from its seat's art the way imd.fun's Telegram page shows it: the mask alone,
 * close. Drawn as an <img> of a cleaned SVG, so nothing in the art can run in the panel. Kept in local
 * storage, so the panel shows faces at once, and read again a few times a day.
 */

const HIDDEN = [
  // the stars, grid, curves, orbits, ticks, side text and bars (imd-website globals.css `.telegram-face`)
  "g[opacity='.68']", "g[opacity='.42']", "g[opacity='.72']", "g[font-family]", "g[stroke-opacity='.5']", "g[filter*='glow'][fill='none']",
  ":scope > path", "g[filter*='glow']:not([fill='none']) > path",
  // the background and the name under the face
  ":scope > rect[width='900'][height='900']", "g[text-anchor='middle']",
];

/** The seat's art reduced to its face: smaller than imd.fun draws it, so its lines are heavier, as small type is cut bolder. */
export function faceOf(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror")) return null;
  for (const selector of HIDDEN) root.querySelectorAll(selector).forEach((node) => node.remove());
  // nothing that runs or reaches out survives, even though an <img> would run none of it
  root.querySelectorAll("script, foreignObject, a, iframe").forEach((node) => node.remove());
  root.querySelectorAll("g[filter*='shadow'] [stroke-width]").forEach((node) => {
    const width = Number(node.getAttribute("stroke-width"));
    if (Number.isFinite(width)) node.setAttribute("stroke-width", String(width * 2.2));
  });
  // the face runs from 201 to 724 down the art, centred on 450 across: a square around it and its edge
  root.setAttribute("viewBox", "184 196 532 532");
  root.setAttribute("shape-rendering", "geometricPrecision");
  root.removeAttribute("width");
  root.removeAttribute("height");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

const STORE = "imd-agents:faces";
const DAY = 6 * 60 * 60 * 1000;
const faces = new Map<string, string>();
const asked = new Map<string, number>();

try {
  for (const [token, face] of Object.entries(JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, string>)) faces.set(token, face);
} catch { /* a fresh start draws them again */ }

export const faceFor = (tokenId: string) => faces.get(tokenId) ?? null;

/** Reads a face if it is new or old, and calls back once it has one to draw. */
export async function loadFace(tokenId: string, drawn: () => void): Promise<void> {
  if (Date.now() - (asked.get(tokenId) ?? 0) < DAY && faces.has(tokenId)) return;
  asked.set(tokenId, Date.now());
  const svg = await agentSvg(tokenId).catch(() => null);
  const face = svg ? faceOf(svg) : null;
  if (!face || faces.get(tokenId) === face) return;
  faces.set(tokenId, face);
  try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(faces))); } catch { /* full: drawn again next time */ }
  drawn();
}
