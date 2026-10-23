const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pricing = require('./pricing');

/* Per-file cache: every .jsonl file is parsed once into a compact entry and reused until its
   size or mtime changes. The aggregate is rebuilt from entries, which is fast, so rescans
   after the first one only read the files that actually changed. */
const CACHE_VERSION = 2;

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const dk = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function newSrc() {
  return { days: {}, models: {}, projects: {}, skills: {}, msgs: 0, think: 0, fast: 0, sessions: 0, files: 0, longest: { ms: 0, day: null }, hours: new Array(24).fill(0), wdays: new Array(7).fill(0), usd: {}, unpriced: 0, blocks: [], peak: { t: 0, s: 0 }, top: [] };
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

/* rec = [keyHash, ts, modelIdx, in, out, cacheWrite, cacheRead, thinking, fast, hasUsage] */
async function parseFile(file, root, onBytes) {
  const rel = path.relative(root, file).split(path.sep);
  const proj = rel.length > 1 ? rel[0] : 'unknown';
  const segs = proj.split('-').filter(Boolean);
  const sub = rel.includes('subagents');
  const e = { proj: segs.length ? segs[segs.length - 1] : proj, models: [], recs: [], skills: {}, longest: { ms: 0, day: null }, session: 0, tok: 0 };
  const tl = [], byKey = new Map(), modelIdx = new Map();
  const mi = (name) => {
    if (!modelIdx.has(name)) { modelIdx.set(name, e.models.length); e.models.push(name); }
    return modelIdx.get(name);
  };

  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (onBytes) stream.on('data', (c) => onBytes(c.length));
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 2) continue;
    let o;
    try { o = JSON.parse(line); } catch (err) { continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (isNaN(ts)) continue;
    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      const content = Array.isArray(m.content) ? m.content : [];
      let think = false;
      for (const c of content) {
        if (c.type === 'thinking') think = true;
        if (c.type === 'tool_use' && c.name === 'Skill' && c.input && c.input.skill) e.skills[c.input.skill] = (e.skills[c.input.skill] || 0) + 1;
      }
      if (!sub && !o.isSidechain) tl.push([ts, 0]);
      const u = m.usage;
      if (m.model === '<synthetic>' || (!u && !think)) continue;
      const key = m.id ? m.id + ':' + (o.requestId || '') : null;
      let rec = key ? byKey.get(key) : null;
      if (!rec) {
        rec = [key ? hash(key) : 0, ts, mi(m.model || 'unknown'), 0, 0, 0, 0, 0, 0, 0];
        e.recs.push(rec);
        if (key) byKey.set(key, rec);
      }
      if (think) rec[7] = 1;
      if (u && !rec[9]) {
        rec[3] = u.input_tokens || 0; rec[4] = u.output_tokens || 0;
        rec[5] = u.cache_creation_input_tokens || 0; rec[6] = u.cache_read_input_tokens || 0;
        rec[8] = u.speed === 'fast' ? 1 : 0; rec[9] = 1;
        e.tok += rec[3] + rec[4] + rec[5] + rec[6];
      }
    } else if (o.type === 'user') {
      if (sub || o.isSidechain) continue;
      const mc = o.message && o.message.content;
      let prompt = false;
      if (typeof mc === 'string') prompt = true;
      else if (Array.isArray(mc)) prompt = !mc.some((b) => b.type === 'tool_result');
      if (o.isMeta) prompt = false;
      tl.push([ts, prompt ? 1 : 0]);
    }
  }
  if (!sub && tl.length) { e.session = 1; e.longest = longestTask(tl); }
  return e;
}

function longestTask(tl) {
  tl.sort((a, b) => a[0] - b[0]);
  const best = { ms: 0, day: null };
  let cur = null;
  const close = () => { if (cur && cur.dur > best.ms) { best.ms = cur.dur; best.day = dk(cur.start); } };
  for (const e of tl) {
    if (e[1] === 1) { close(); cur = { start: e[0], last: e[0], dur: 0 }; }
    else if (cur) { cur.dur += Math.min(e[0] - cur.last, 15 * 60000); cur.last = e[0]; }
  }
  close();
  return best;
}

/* entries: [[file, entry], ...] in a stable order. Replies are de-duplicated by message id
   across files, because resumed sessions replay earlier history into a new file. */
function build(entries) {
  const src = newSrc(), seen = new Set(), ev = [], tops = [];
  for (const [, e] of entries) {
    src.files++;
    let eTok = 0, eUsd = 0, eMsgs = 0, eFirst = Infinity;
    if (e.session) src.sessions++;
    if (e.longest.ms > src.longest.ms) src.longest = { ms: e.longest.ms, day: e.longest.day };
    for (const k in e.skills) src.skills[k] = (src.skills[k] || 0) + e.skills[k];
    for (const r of e.recs) {
      if (r[0]) { if (seen.has(r[0])) continue; seen.add(r[0]); }
      if (r[7]) src.think++;
      if (!r[9]) continue;
      const v = [r[3], r[4], r[5], r[6]];
      const when = new Date(r[1]), sum = v[0] + v[1] + v[2] + v[3];
      src.hours[when.getHours()] += sum;
      src.wdays[when.getDay()] += sum;
      add4(src.days, dk(r[1]), v);
      add4(src.models, e.models[r[2]], v);
      add4(src.projects, e.proj, v);
      src.msgs++;
      if (r[8]) src.fast++;
      const usd = pricing.value(e.models[r[2]], v), day = dk(r[1]);
      if (usd === null) src.unpriced += sum;
      else { src.usd[day] = (src.usd[day] || 0) + usd; eUsd += usd; }
      eTok += sum; eMsgs++;
      if (r[1] < eFirst) eFirst = r[1];
      ev.push([r[1], sum]);
    }
    if (eMsgs) tops.push({ p: e.proj, t: eTok, u: Math.round(eUsd * 100) / 100, m: eMsgs, d: dk(eFirst) });
  }
  src.top = tops.sort((a, b) => b.u - a.u || b.t - a.t).slice(0, 8);

  /* Usage windows: a new 5-hour block starts with the first reply after the last block ended, rounded
     down to the hour. Claude's own limit is not in the logs, so the biggest block ever is the yardstick. */
  const H = 36e5;
  ev.sort((a, b) => a[0] - b[0]);
  const blocks = [];
  let cur = null;
  for (const [ts, t] of ev) {
    if (!cur || ts >= cur.s + 5 * H) { cur = { s: Math.floor(ts / H) * H, f: ts, t: 0, m: 0 }; blocks.push(cur); }
    cur.t += t; cur.m++;
  }
  blocks.forEach((b) => { if (b.t > src.peak.t) src.peak = { t: b.t, s: b.s }; });
  src.blocks = blocks.slice(-30);
  return src;
}

/* prev: { [file]: { m, s, e } } from the last run. Returns the aggregate plus the new cache. */
async function scan(dir, prev, onProgress) {
  const paths = walk(dir, []).sort();
  const stats = paths.map((p) => { try { const s = fs.statSync(p); return { p, m: s.mtimeMs, s: s.size }; } catch (e) { return null; } }).filter(Boolean);
  const fresh = (st) => { const c = prev && prev[st.p]; return c && c.m === st.m && c.s === st.s ? c : null; };
  const total = stats.reduce((t, st) => t + (fresh(st) ? 0 : st.s), 0);

  const files = {}, list = [];
  let done = 0, tokens = 0, changed = !prev || Object.keys(prev).length !== stats.length, lastSent = 0;
  const send = (i, force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastSent < 100)) return;
    lastSent = now;
    onProgress({ i, n: stats.length, bytes: done, total, tokens });
  };

  for (let i = 0; i < stats.length; i++) {
    const st = stats[i];
    let c = fresh(st);
    if (!c) {
      changed = true;
      try {
        const e = await parseFile(st.p, dir, (n) => { done += n; send(i + 1); });
        c = { m: st.m, s: st.s, e };
      } catch (err) { continue; }
    }
    files[st.p] = c;
    list.push([st.p, c.e]);
    tokens += c.e.tok;
    send(i + 1, i === stats.length - 1);
  }

  const agg = build(list);
  return { agg: Object.keys(agg.days).length ? agg : null, files, changed };
}

module.exports = { CACHE_VERSION, scan, build, parseFile, dk, newSrc };
