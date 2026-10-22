const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const defaultDir = () => path.join(os.homedir(), '.claude', 'projects');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const aggFile = () => path.join(app.getPath('userData'), 'agg.json');

function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) { return {}; } }
function writeCfg(c) { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c)); }
function projectsDir() { return readCfg().dir || defaultDir(); }

/* ---------- log parsing ---------- */
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dk = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

function emptyAgg() {
  return { days: {}, models: {}, projects: {}, skills: {}, msgs: 0, think: 0, fast: 0, sessions: 0, files: 0, longest: { ms: 0, day: null }, source: 'logs', savedAt: Date.now() };
}
function add4(map, key, v) {
  const a = map[key] || (map[key] = [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) a[i] += v[i];
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function parseLine(line, ctx, agg, seen, thinkSeen) {
  let o;
  try { o = JSON.parse(line); } catch (e) { return; }
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (isNaN(ts)) return;
  if (o.type === 'assistant' && o.message) {
    const m = o.message;
    const key = (m.id || '') + ':' + (o.requestId || '');
    const content = Array.isArray(m.content) ? m.content : [];
    for (const c of content) {
      if (c.type === 'thinking' && m.id && !thinkSeen.has(key)) { thinkSeen.add(key); agg.think++; }
      if (c.type === 'tool_use' && c.name === 'Skill' && c.input && c.input.skill) {
        agg.skills[c.input.skill] = (agg.skills[c.input.skill] || 0) + 1;
      }
    }
    if (!ctx.sub && !o.isSidechain) ctx.tl.push([ts, 0]);
    const u = m.usage;
    if (!u || m.model === '<synthetic>') return;
    if (m.id && seen.has(key)) return;
    if (m.id) seen.add(key);
    const v = [u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0];
    add4(agg.days, dk(ts), v);
    add4(agg.models, m.model || 'unknown', v);
    add4(agg.projects, ctx.project, v);
    agg.msgs++;
    if (u.speed === 'fast') agg.fast++;
  } else if (o.type === 'user') {
    if (ctx.sub || o.isSidechain) return;
    const mc = o.message && o.message.content;
    let prompt = false;
    if (typeof mc === 'string') prompt = true;
    else if (Array.isArray(mc)) prompt = !mc.some((b) => b.type === 'tool_result');
    if (o.isMeta) prompt = false;
    ctx.tl.push([ts, prompt ? 1 : 0]);
  }
}

function finishTasks(ctx, agg) {
  const tl = ctx.tl.sort((a, b) => a[0] - b[0]);
  let cur = null;
  const close = () => {
    if (cur && cur.dur > agg.longest.ms) { agg.longest.ms = cur.dur; agg.longest.day = dk(cur.start); }
  };
  for (const e of tl) {
    if (e[1] === 1) { close(); cur = { start: e[0], last: e[0], dur: 0 }; }
    else if (cur) { cur.dur += Math.min(e[0] - cur.last, 15 * 60000); cur.last = e[0]; }
  }
  close();
}

async function readFile(file, root, agg, seen, thinkSeen) {
  const rel = path.relative(root, file).split(path.sep);
  const proj = rel.length > 1 ? rel[0] : 'unknown';
  const segs = proj.split('-').filter(Boolean);
  const ctx = { tl: [], project: segs.length ? segs[segs.length - 1] : proj, sub: rel.includes('subagents') };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) { if (line.length > 1) parseLine(line, ctx, agg, seen, thinkSeen); }
  if (!ctx.sub && ctx.tl.length) { agg.sessions++; finishTasks(ctx, agg); }
}

let scanning = null;
async function scan(sender) {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) return { error: 'nofolder', dir };
  const files = walk(dir, []);
  const agg = emptyAgg();
  agg.files = files.length;
  const seen = new Set(), thinkSeen = new Set();
  let last = 0, tokens = 0;
  for (let i = 0; i < files.length; i++) {
    try { await readFile(files[i], dir, agg, seen, thinkSeen); } catch (e) { /* skip unreadable file */ }
    const now = Date.now();
    if (now - last > 120 || i === files.length - 1) {
      last = now;
      tokens = Object.values(agg.days).reduce((t, a) => t + a[0] + a[1] + a[2] + a[3], 0);
      if (!sender.isDestroyed()) sender.send('progress', { i: i + 1, n: files.length, tokens });
    }
  }
  if (!Object.keys(agg.days).length) return { error: 'empty', dir };
  agg.savedAt = Date.now();
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(aggFile(), JSON.stringify(agg)); } catch (e) { /* cache is optional */ }
  return { agg };
}

/* ---------- ipc ---------- */
ipcMain.handle('scan', (ev) => {
  if (!scanning) scanning = scan(ev.sender).finally(() => { scanning = null; });
  return scanning;
});
ipcMain.handle('cached', () => { try { return JSON.parse(fs.readFileSync(aggFile(), 'utf8')); } catch (e) { return null; } });
ipcMain.handle('chooseFolder', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const startDir = fs.existsSync(defaultDir()) ? defaultDir() : os.homedir();
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose your Claude Code projects folder',
    defaultPath: startDir,
    properties: ['openDirectory', 'showHiddenFiles']
  });
  if (r.canceled || !r.filePaths.length) return false;
  writeCfg({ ...readCfg(), dir: r.filePaths[0] });
  try { fs.unlinkSync(aggFile()); } catch (e) { /* none cached */ }
  return true;
});

/* ---------- window ---------- */
function createWindow() {
  const win = new BrowserWindow({
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
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
