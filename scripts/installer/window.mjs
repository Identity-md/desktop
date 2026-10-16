// The disk image's window: its content size, and where Finder puts the two icons, as background.mjs
// draws the background for them and `pnpm release` lays them out.
export const WINDOW = { width: 700, height: 436 };
export const ICONS = { app: [250, 207], applications: [450, 207] };
// Finder's title bar sits above the content; create-dmg sizes the whole window.
export const TITLE_BAR = 32;
