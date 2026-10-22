const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const logs = require('./lib/logs');
const chat = require('./lib/chat');
const updaterLib = require('./lib/updater');

const defaultDir = () => path.join(os.homedir(), '.claude', 'projects');
const store = (name) => path.join(app.getPath('userData'), name);

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
const readCfg = () => readJson(store('config.json')) || {};
const projectsDir = () => readCfg().dir || defaultDir();

/* ---------- state sent to the window ---------- */
function loadState(extra) {
  const code = readJson(store('agg.json'));
  return Object.assign({ code, chat: readJson(store('chat.json')) }, extra);
}

let scanning = null;
async function scan(progress) {
  const dir = projectsDir();
  let code = null, error = null;
  if (!fs.existsSync(dir)) {
    error = 'nofolder';
  } else {
    const cache = readJson(store('entries-v' + logs.CACHE_VERSION + '.json'));
    const r = await logs.scan(dir, cache && cache.v === logs.CACHE_VERSION ? cache.files : {}, progress);
    if (!r.agg) {
      error = 'empty';
    } else {
      code = Object.assign(r.agg, { savedAt: Date.now() });
      try {
        writeJson(store('agg.json'), code);
        if (r.changed) writeJson(store('entries-v' + logs.CACHE_VERSION + '.json'), { v: logs.CACHE_VERSION, files: r.files });
      } catch (e) { /* caches are optional */ }
    }
  }
  const result = { code, chat: readJson(store('chat.json')), error, dir };
  updateTray(result);
  return result;
}

function runScan(progress) {
  if (!scanning) scanning = scan(progress).finally(() => { scanning = null; });
  return scanning;
}

/* ---------- menu bar item: today's tokens ---------- */
let tray = null, lastTotals = null;
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K' : String(Math.round(n)));
function todayTokens(state) {
  const key = logs.dk(Date.now());
  return [state.code, state.chat].reduce((t, s) => {
    const a = s && s.days && s.days[key];
    return t + (a ? a[0] + a[1] + a[2] + a[3] : 0);
  }, 0);
}
function updateTray(state) {
  if (process.platform !== 'darwin' || readCfg().tray === false) { if (tray) { tray.destroy(); tray = null; } return; }
  lastTotals = state;
  if (!tray) {
    tray = new Tray(nativeImage.createEmpty());
    tray.on('click', showWindow);
  }
  tray.setTitle('◐ ' + fmt(todayTokens(state)));
  tray.setToolTip('Token Trail: tokens used today');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: fmt(todayTokens(state)) + ' tokens today', enabled: false },
    { type: 'separator' },
    { label: 'Open Token Trail', click: showWindow },
    { label: 'Rescan now', click: () => refresh() },
    { type: 'separator' },
    { label: 'Hide menu bar item', click: () => { fs.writeFileSync(store('config.json'), JSON.stringify({ ...readCfg(), tray: false })); updateTray(state); } },
    { role: 'quit' }
  ]));
}
function showWindow() { if (!win || win.isDestroyed()) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

/* Background refresh: used by the file watcher and the menu. Pushes the new state to the window. */
async function refresh() {
  try {
    const r = await runScan();
    if (win && !win.isDestroyed()) win.webContents.send('state', r);
  } catch (e) { /* next change retries */ }
}

/* Re-scan a few seconds after Claude Code writes to its logs, so numbers move while you work. */
let watcher = null, watchTimer = null;
function watchLogs() {
  try { if (watcher) watcher.close(); } catch (e) { /* already closed */ }
  watcher = null;
  const dir = projectsDir();
  if (!fs.existsSync(dir)) return;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
      if (!name || !String(name).endsWith('.jsonl')) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(refresh, 5000);
    });
    watcher.on('error', () => { watcher = null; });
  } catch (e) { /* recursive watch unsupported here; focus-rescan still works */ }
}

/* ---------- ipc ---------- */
ipcMain.handle('scan', (ev) => runScan((p) => { if (!ev.sender.isDestroyed()) ev.sender.send('progress', p); }));
ipcMain.handle('saveCsv', async (ev, text, name) => {
  const w = BrowserWindow.fromWebContents(ev.sender);
  const r = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath('downloads'), String(name || 'token-trail.csv').replace(/[^\w.-]/g, '_')), filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, String(text));
  shell.showItemInFolder(r.filePath);
  return true;
});
ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('login:set', (_ev, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return app.getLoginItemSettings().openAtLogin; });
ipcMain.handle('cached', () => loadState());
ipcMain.handle('whoami', () => new Promise((resolve) => {
  const username = os.userInfo().username;
  execFile('id', ['-F'], (err, out) => resolve({ name: (!err && out.trim()) || username, handle: '@' + username }));
}));
ipcMain.handle('chooseFolder', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const startDir = fs.existsSync(defaultDir()) ? defaultDir() : os.homedir();
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose your Claude Code projects folder',
    defaultPath: startDir,
    properties: ['openDirectory', 'showHiddenFiles']
  });
  if (r.canceled || !r.filePaths.length) return false;
  fs.writeFileSync(store('config.json'), JSON.stringify({ ...readCfg(), dir: r.filePaths[0] }));
  try { fs.unlinkSync(store('agg.json')); } catch (e) { /* none cached */ }
  watchLogs();
  return true;
});
ipcMain.handle('importChat', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose your Claude data export',
    message: 'Pick the .zip from Anthropic, or the conversations.json inside it.',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Claude export', extensions: ['zip', 'json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  try {
    const data = await chat.readExport(r.filePaths[0]);
    writeJson(store('chat.json'), data);
    if (lastTotals) updateTray(Object.assign({}, lastTotals, { chat: data }));
    return { chat: data };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('removeChat', () => { try { fs.unlinkSync(store('chat.json')); } catch (e) { /* none */ } return true; });
ipcMain.handle('openExternal', (_ev, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

/* ---------- window + updater ---------- */
let win = null;
const updater = updaterLib.create({
  app, shell,
  send: (s) => { if (win && !win.isDestroyed()) win.webContents.send('update', s); }
});
ipcMain.handle('update:get', () => updater.get());
ipcMain.handle('update:check', () => updater.check(true));
ipcMain.handle('update:install', () => updater.install());

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 420,
    minHeight: 520,
    title: 'Token Trail',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151413' : '#f6f4f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => { showWindow(); updater.check(true); } },
        { type: 'separator' },
        { label: 'Rescan', accelerator: 'CmdOrCtrl+R', click: () => { showWindow(); win.webContents.send('rescan'); } },
        { label: 'Import Chat Export…', accelerator: 'CmdOrCtrl+I', click: () => { showWindow(); win.webContents.send('import'); } },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  updater.init();
  watchLogs();
  /* Fill the menu bar item before the window asks for anything. */
  const cached = loadState();
  if (cached.code || cached.chat) updateTray(cached);
  refresh();
  app.on('activate', showWindow);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { if (watcher) watcher.close(); } catch (e) { /* closing */ } updater.stop(); });
