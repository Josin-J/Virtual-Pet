// Electron main process – transparent, always-on-top, click-through desktop pet.
import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, globalShortcut } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.join(__dirname, '..', 'public', 'icon.svg');

let win;
let tray;

function createWindow() {
  // Full-screen transparent overlay
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,          // don't steal focus from user apps
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Start ignoring mouse events (clicks pass through) – the renderer will
  // toggle forwarding on/off when Pip is hovered.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.setAlwaysOnTop(true, 'screen-saver');   // stay above *everything*
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Remove menu bar
  win.setMenu(null);

  // Dev tools on Ctrl+Shift+I (useful for debugging)
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.control && input.shift && input.key === 'I') {
      win.webContents.toggleDevTools();
    }
  });
}

function createTray() {
  // Use SVG icon if supported, fallback to a simple 16x16 white square
  let icon;
  try {
    icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Pip — Desktop Companion (Ctrl+Alt+P to summon)');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Summon to Mouse (Ctrl+Alt+P)', click: () => summonPip() },
    { label: 'Reset Position', click: () => { win?.webContents.send('reset-position'); } },
    { type: 'separator' },
    { label: 'Quit Pip', click: () => app.quit() },
  ]));
}

function summonPip() {
  const pt = screen.getCursorScreenPoint();
  win?.webContents.send('summon', pt);
}

// IPC: renderer tells us when the cursor is over Pip
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  win?.setIgnoreMouseEvents(ignore, { forward: true });
  if (!ignore) win?.setFocusable(true);
  else setTimeout(() => win?.setFocusable(false), 100);
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Register global shortcut to summon Pip anywhere
  globalShortcut.register('CommandOrControl+Alt+P', summonPip);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());

