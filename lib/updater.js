const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn, execFile } = require('child_process');

/* Self-updater for an app that is not signed with an Apple certificate. Squirrel-based
   updaters refuse unsigned apps, so this checks GitHub Releases, downloads the zip for this
   CPU, verifies it, and swaps the .app bundle with a small shell script after the app quits. */
const REPO = 'AdityaJainDXB/Token-Trail';
const APP_NAME = 'Token Trail.app';
const CHECK_EVERY = 6 * 60 * 60 * 1000;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

function parseVer(v) {
  const m = String(v || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function isNewer(remote, local) {
  const a = parseVer(remote), b = parseVer(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

const SWAP_SCRIPT = `#!/bin/sh
# usage: swap.sh <pid> <new.app> <target.app> <relaunch 0|1>
PID="$1"; NEW="$2"; TARGET="$3"; RELAUNCH="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
BACKUP="$TARGET.old-$$"
if mv "$TARGET" "$BACKUP"; then
  if ditto "$NEW" "$TARGET"; then
    rm -rf "$BACKUP"
    xattr -cr "$TARGET" 2>/dev/null
    rm -rf "$(dirname "$NEW")"
  else
    rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"
  fi
fi
[ "$RELAUNCH" = "1" ] && open "$TARGET"
exit 0
`;

function create({ app, shell, send }) {
  const dir = () => path.join(app.getPath('userData'), 'update');
  const readyFile = () => path.join(dir(), 'ready.json');
  const current = app.getVersion();
  let state = { state: 'idle', current };
  let busy = false, spawned = false, timer = null;

  const set = (patch) => { state = Object.assign({}, state, patch, { current }); send(state); return state; };

  /* The bundle this process is running from, or null when it cannot be replaced in place
     (dev run, a mounted DMG, Gatekeeper translocation, or a read-only folder). */
  function target() {
    if (!app.isPackaged) return null;
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    if (!bundle.endsWith('.app') || /\/AppTranslocation\/|^\/Volumes\//.test(bundle)) return null;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch (e) { return null; }
    return bundle;
  }

  function readReady() {
    try {
      const r = JSON.parse(fs.readFileSync(readyFile(), 'utf8'));
      return r && fs.existsSync(r.app) ? r : null;
    } catch (e) { return null; }
  }

  async function download(asset, version) {
    fs.rmSync(dir(), { recursive: true, force: true });
    const work = path.join(dir(), version);
    fs.mkdirSync(work, { recursive: true });
    const zip = path.join(work, 'update.zip');
    set({ state: 'downloading', version, progress: 0 });

    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Token-Trail' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error('Download failed (' + res.status + ')');
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    let got = 0, lastSent = 0;
    const meter = new Transform({
      transform(chunk, _enc, done) {
        got += chunk.length;
        const now = Date.now();
        if (total && now - lastSent > 200) { lastSent = now; set({ progress: Math.min(1, got / total) }); }
        done(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(zip));

    /* Verify the file as written, not the bytes that streamed past: a chunk lost on the way to disk
       would pass a check made on the stream. */
    if (asset.size && fs.statSync(zip).size !== asset.size) throw new Error('Download was incomplete');
    const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    if (want && want[1].toLowerCase() !== await sha256File(zip)) throw new Error('Checksum mismatch, update discarded');

    const out = path.join(work, 'app');
    await new Promise((resolve, reject) => execFile('/usr/bin/ditto', ['-xk', zip, out], (err) => (err ? reject(err) : resolve())));
    fs.rmSync(zip, { force: true });
    const bundle = path.join(out, APP_NAME);
    if (!fs.existsSync(bundle)) throw new Error('Update archive did not contain ' + APP_NAME);
    fs.writeFileSync(readyFile(), JSON.stringify({ version, app: bundle }));
    return bundle;
  }

  async function check(manual) {
    if (busy) return state;
    busy = true;
    if (manual) set({ state: 'checking', error: null });
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Token-Trail' },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error('GitHub answered ' + res.status);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/i, '');
      if (!isNewer(version, current)) { set({ state: 'current', version: null, checkedAt: Date.now(), error: null }); return state; }

      const notes = String(rel.body || '').slice(0, 1500);
      const info = { version, notes, page: rel.html_url, checkedAt: Date.now(), error: null };
      const asset = (rel.assets || []).find((a) => a.name.endsWith('-' + process.arch + '.zip'));
      const ready = readReady();
      if (ready && ready.version === version) { set(Object.assign(info, { state: 'ready', installable: !!target() })); return state; }
      if (!asset) { set(Object.assign(info, { state: 'available', installable: false })); return state; }

      set(Object.assign(info, { state: 'available', installable: !!target() }));
      await download(asset, version);
      set({ state: 'ready', progress: 1, installable: !!target() });
    } catch (e) {
      /* A failed download must not leave a half-written update behind. */
      try { if (!readReady()) fs.rmSync(dir(), { recursive: true, force: true }); } catch (err) { /* nothing to clean */ }
      set({ state: manual || state.version ? 'error' : 'idle', error: String((e && e.message) || e), checkedAt: Date.now() });
    } finally { busy = false; }
    return state;
  }

  function spawnSwap(relaunch) {
    const ready = readReady(), tgt = target();
    if (!ready || !tgt || spawned) return false;
    spawned = true;
    const script = path.join(dir(), 'swap.sh');
    fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    spawn('/bin/sh', [script, String(process.pid), ready.app, tgt, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  /* Restart now, or fall back to the release page when the bundle cannot be replaced. */
  function install() {
    if (state.state !== 'ready') return { ok: false };
    if (!spawnSwap(true)) { shell.openExternal(state.page || 'https://github.com/' + REPO + '/releases/latest'); return { ok: false, manual: true }; }
    app.quit();
    return { ok: true };
  }

  function init() {
    setTimeout(() => check(false), 8000);
    timer = setInterval(() => check(false), CHECK_EVERY);
    /* A downloaded update is applied when the app quits, so users who never click the button still get it. */
    app.on('will-quit', () => { if (!spawned && readReady()) spawnSwap(false); });
  }

  return { init, check, install, get: () => state, stop: () => clearInterval(timer) };
}

module.exports = { create, isNewer, parseVer, SWAP_SCRIPT };
