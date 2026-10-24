/** Which computer the app runs on, from its web view: WebKit says Mac, WebView2 says Windows. */
export const mac = /Mac/.test(navigator.userAgent);
export const windows = /Windows/.test(navigator.userAgent);

/** A shortcut as this computer writes it: ⌘Q and ⇧U on a Mac, Ctrl+Q and Shift+U elsewhere. */
export const ctrl = (key: string) => (mac ? `⌘${key}` : `Ctrl+${key}`);
export const shift = (key: string) => (mac ? `⇧${key}` : `Shift+${key}`);

/** Where the app's icon lives, in the words this computer uses for it. */
export const iconHome = mac ? "menu bar" : windows ? "taskbar" : "tray";
