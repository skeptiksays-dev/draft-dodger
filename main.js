// DoTA Draft Dodger desktop app: the Draft Dodger site in its own window, with the
// Dota Game State Integration listener built in.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog, Menu, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');
const gsi = require('./gsi');

const SITE_DIR = path.join(__dirname, 'app');
const APP_ORIGIN = 'app://draftdodger';
const WEBSITE = 'https://draftdodger.netlify.app/';

app.setAppUserModelId('app.draftdodger');   // lets Windows show our notifications

// The site is served from app://draftdodger/ so it gets a stable, secure origin of its own
// (saved settings, drafts and history live under it).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// Only one copy at a time: a second launch just brings the first window forward
if (!app.requestSingleInstanceLock()) { app.exit(0); }

let win = null;
let server = null;
let setup = { dota: null, cfg: null, launch: 'unknown' };

/* ---------- Small settings file ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (e) { return {}; } }
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 1)); } catch (e) { /* not critical */ }
  return s;
}

/* ---------- Dota setup: config file and launch option ---------- */
function runSetup() {
  const s = loadSettings();
  let dota = null;
  if (s.cfgDir && fs.existsSync(s.cfgDir)) dota = { steamRoot: null, cfgDir: s.cfgDir };
  if (!dota) dota = gsi.findDota();
  setup.dota = dota;
  setup.cfg = dota ? gsi.installCfg(dota.cfgDir) : { status: 'notfound' };
  const roots = gsi.steamRoots();
  if (dota && dota.steamRoot && !roots.includes(dota.steamRoot)) roots.unshift(dota.steamRoot);
  setup.launch = gsi.launchOptionStatus(roots);
  return setupInfo();
}
function setupInfo() {
  const snap = server ? server.snapshot() : {};
  return {
    cfg: setup.cfg, cfgDir: setup.dota ? setup.dota.cfgDir : null, launch: setup.launch,
    server: { ok: !!server && !server.error, port: gsi.PORT, error: snap.error || null, message: snap.message || '' },
    logDir: path.join(app.getPath('userData'), 'logs'), version: app.getVersion()
  };
}

/* ---------- Game state for the page ---------- */
// If the separate helper window already holds the port, read its data instead (it allows requests without an Origin).
function readOldHelper() {
  return new Promise(resolve => {
    const r = http.get({ hostname: 'localhost', port: gsi.PORT, path: '/state', timeout: 1500 }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { const j = JSON.parse(body); resolve(typeof j.state === 'string' ? { ...j, state: JSON.parse(j.state) } : j); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
async function gameState() {
  const snap = server.snapshot();
  if (snap.error === 'port') {
    const other = await readOldHelper();
    if (other && other.helper === 'draftdodger') return { ...other, viaHelper: true };
  }
  return snap;
}

/* ---------- Window ---------- */
function createWindow() {
  const s = loadSettings();
  const b = s.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1400, height: b.height || 920, x: b.x, y: b.y,
    minWidth: 420, minHeight: 480,
    backgroundColor: '#0e1214',
    title: 'DoTA Draft Dodger',
    icon: path.join(SITE_DIR, 'icon-256.png'),
    autoHideMenuBar: true,
    alwaysOnTop: !!s.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (s.maximized) win.maximize();
  win.loadURL(APP_ORIGIN + '/index.html');

  // Links to other sites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });

  const remember = () => { if (!win || win.isDestroyed()) return; saveSettings({ maximized: win.isMaximized(), ...(win.isMaximized() || win.isMinimized() ? {} : { bounds: win.getBounds() }) }); };
  win.on('resize', remember); win.on('move', remember); win.on('close', remember);
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const top = () => { if (!win) return; const on = !win.isAlwaysOnTop(); win.setAlwaysOnTop(on); saveSettings({ alwaysOnTop: on }); win.webContents.send('win:top', on); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'View', submenu: [
      { label: 'Always on top', accelerator: 'CmdOrCtrl+T', click: top },
      { type: 'separator' },
      { role: 'reload' }, { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' }
    ] },
    { label: 'Help', submenu: [
      { label: 'Open the website', click: () => shell.openExternal(WEBSITE) },
      { label: 'Open log folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
      { label: 'Check for updates', click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: 'About Draft Dodger', click: () => dialog.showMessageBox(win, { type: 'info', title: 'DoTA Draft Dodger',
        message: 'DoTA Draft Dodger ' + app.getVersion(),
        detail: 'A fan-made Dota 2 drafting tool. Not affiliated with or endorsed by Valve Corporation.\nData from OpenDota and STRATZ. Game data through Valve\'s official Game State Integration.' }) }
    ] }
  ]));
}

/* ---------- Updates (from GitHub Releases) ---------- */
let updater = null;
let manualCheck = false;
function checkForUpdates(manual) {
  manualCheck = !!manual;
  if (!app.isPackaged) { if (manual) dialog.showMessageBox(win, { message: 'Updates only work in the installed app.' }); return; }
  try {
    if (!updater) {
      updater = require('electron-updater').autoUpdater;
      updater.autoDownload = true;
      updater.on('update-downloaded', info => {
        dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
          message: `Draft Dodger ${info.version} is ready`, detail: 'Restart to finish updating. Otherwise it installs the next time you close the app.' })
          .then(r => { if (r.response === 0) updater.quitAndInstall(); });
      });
      updater.on('error', e => { if (manualCheck) dialog.showMessageBox(win, { type: 'warning', message: 'Couldn\'t check for updates', detail: String(e && e.message || e) }); });
    }
    updater.checkForUpdates().then(r => {
      if (manual && (!r || !r.updateInfo || r.updateInfo.version === app.getVersion())) dialog.showMessageBox(win, { message: 'You have the latest version (' + app.getVersion() + ').' });
    }).catch(() => {});
  } catch (e) { /* updater missing in development */ }
}

/* ---------- IPC for the page ---------- */
ipcMain.handle('gsi:state', () => gameState());
ipcMain.handle('gsi:setup', (e, opts) => (opts && opts.rerun) ? runSetup() : setupInfo());
ipcMain.handle('gsi:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your "dota 2 beta" folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return setupInfo();
  const cfgDir = gsi.cfgDirFrom(r.filePaths[0]);
  if (!cfgDir) { await dialog.showMessageBox(win, { type: 'warning', message: 'That doesn\'t look like the Dota 2 folder', detail: 'Pick the "dota 2 beta" folder, usually in Steam\\steamapps\\common.' }); return setupInfo(); }
  saveSettings({ cfgDir });
  return runSetup();
});
ipcMain.handle('win:top', (e, on) => { if (!win) return false; const v = (on === undefined) ? !win.isAlwaysOnTop() : !!on; win.setAlwaysOnTop(v); saveSettings({ alwaysOnTop: v }); return v; });
ipcMain.handle('win:isTop', () => !!win && win.isAlwaysOnTop());
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('app:logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
ipcMain.handle('app:update', () => checkForUpdates(true));

/* ---------- Start ---------- */
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  // Serve the bundled site, refusing anything outside its folder
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(SITE_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
    if (!file.startsWith(SITE_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // OpenDota and STRATZ answer browsers with CORS headers already; this makes sure the app's own origin is accepted too
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['https://api.opendota.com/*', 'https://api.stratz.com/*'] },
    (details, cb) => {
      const h = details.responseHeaders || {};
      for (const k of Object.keys(h)) if (/^access-control-allow-(origin|headers)$/i.test(k)) delete h[k];
      h['Access-Control-Allow-Origin'] = [APP_ORIGIN];
      h['Access-Control-Allow-Headers'] = ['Authorization, Content-Type'];
      cb({ responseHeaders: h, statusLine: details.method === 'OPTIONS' ? 'HTTP/1.1 204 No Content' : details.statusLine });
    });

  server = gsi.createGsiServer({
    version: app.getVersion(),
    logFile: path.join(app.getPath('userData'), 'logs', 'gsi-log.jsonl'),
    onPhase: (phase) => {
      if (phase === 'HERO_SELECTION' && win && !win.isFocused() && Notification.isSupported()) {
        const n = new Notification({ title: 'Draft is starting', body: 'Draft Dodger is filling in the board.', icon: path.join(SITE_DIR, 'icon-256.png') });
        n.on('click', () => { if (win) { win.show(); win.focus(); } });
        n.show();
      }
    }
  });
  await server.start();
  runSetup();
  buildMenu();
  createWindow();
  setTimeout(() => checkForUpdates(false), 5000);
});

app.on('before-quit', () => { if (server) server.close(); });
