const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { dk } = require('./logs');

/* The claude.ai data export (Settings > Privacy > Export data) has every conversation with
   timestamps but no token counts, so tokens are estimated from text length. */
const CHARS_PER_TOKEN = 3.7;

function blockText(b) {
  if (!b) return '';
  if (typeof b === 'string') return b;
  let s = b.text || b.thinking || '';
  if (b.input) s += JSON.stringify(b.input);
  if (b.content) s += typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
  return s;
}

function messageChars(m) {
  let n = 0;
  if (Array.isArray(m.content) && m.content.length) n = m.content.reduce((t, b) => t + blockText(b).length, 0);
  else n = (m.text || '').length;
  if (Array.isArray(m.attachments)) n += m.attachments.reduce((t, a) => t + (a.extracted_content || '').length, 0);
  return n;
}

function emptyChat() {
  return { days: {}, models: {}, projects: {}, skills: {}, msgs: 0, think: 0, fast: 0, sessions: 0, files: 0, longest: { ms: 0, day: null }, hours: new Array(24).fill(0), wdays: new Array(7).fill(0), conversations: 0, importedAt: Date.now(), from: '' };
}

function parseExport(json, from) {
  const convs = Array.isArray(json) ? json : [];
  const out = emptyChat();
  out.from = from || '';
  const addTo = (map, key, i, o) => { const a = map[key] || (map[key] = [0, 0, 0, 0]); a[0] += i; a[1] += o; };
  for (const c of convs) {
    const msgs = Array.isArray(c.chat_messages) ? c.chat_messages : [];
    if (!msgs.length) continue;
    out.conversations++;
    const title = (c.name || '').trim() || 'Untitled chat';
    const model = c.model || 'Claude chat';
    for (const m of msgs) {
      const ts = Date.parse(m.created_at || c.created_at);
      if (isNaN(ts)) continue;
      const tokens = Math.ceil(messageChars(m) / CHARS_PER_TOKEN);
      const human = m.sender === 'human';
      const i = human ? tokens : 0, o = human ? 0 : tokens;
      const when = new Date(ts);
      out.hours[when.getHours()] += tokens;
      out.wdays[when.getDay()] += tokens;
      addTo(out.days, dk(ts), i, o);
      addTo(out.models, model, i, o);
      addTo(out.projects, title, i, o);
      if (!human) out.msgs++;
    }
  }
  return out;
}

/* Accepts the export .zip, or the conversations.json inside it. */
function readExport(file) {
  return new Promise((resolve, reject) => {
    const parse = (text) => {
      let json;
      try { json = JSON.parse(text); } catch (e) { return reject(new Error('That file is not valid JSON. Pick the export .zip or conversations.json.')); }
      const chat = parseExport(json, path.basename(file));
      if (!chat.conversations) return reject(new Error('No conversations found in that file.'));
      resolve(chat);
    };
    if (/\.json$/i.test(file)) {
      fs.readFile(file, 'utf8', (err, text) => (err ? reject(err) : parse(text)));
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-trail-'));
    execFile('/usr/bin/unzip', ['-o', '-j', file, 'conversations.json', '-d', tmp], { maxBuffer: 1 << 20 }, (err) => {
      const target = path.join(tmp, 'conversations.json');
      fs.readFile(target, 'utf8', (e2, text) => {
        fs.rm(tmp, { recursive: true, force: true }, () => {});
        if (e2) return reject(new Error(err ? 'Could not open that zip. Pick the export .zip from Anthropic or its conversations.json.' : 'conversations.json was not in that zip.'));
        parse(text);
      });
    });
  });
}

module.exports = { readExport, parseExport };
