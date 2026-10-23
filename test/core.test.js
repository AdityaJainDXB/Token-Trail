const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const logs = require('../lib/logs');
const chat = require('../lib/chat');
const updater = require('../lib/updater');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tt-test-'));
const line = (o) => JSON.stringify(o) + '\n';
const reply = (id, ts, usage, extra) => line({ type: 'assistant', timestamp: ts, requestId: 'r' + id, message: Object.assign({ id, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }], usage }, extra) });
const prompt = (ts) => line({ type: 'user', timestamp: ts, message: { content: 'do it' } });

function fixture() {
  const root = tmp();
  const proj = path.join(root, '-Users-me-Projects-alpha');
  fs.mkdirSync(proj);
  const u = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };
  fs.writeFileSync(path.join(proj, 'a.jsonl'),
    prompt('2026-03-02T10:00:00Z') + reply('m1', '2026-03-02T10:01:00Z', u) + reply('m2', '2026-03-02T10:02:00Z', u, { content: [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', name: 'Skill', input: { skill: 'plan' } }] }));
  /* A resumed session replays m1 into a second file: it must not be counted twice. */
  fs.writeFileSync(path.join(proj, 'b.jsonl'), reply('m1', '2026-03-02T10:01:00Z', u) + reply('m3', '2026-03-03T11:00:00Z', u));
  return root;
}

test('versions compare numerically', () => {
  assert.ok(updater.isNewer('1.10.0', '1.9.9'));
  assert.ok(updater.isNewer('v2.0.0', '1.99.99'));
  assert.ok(!updater.isNewer('1.1.0', '1.1.0'));
  assert.ok(!updater.isNewer('1.0.9', '1.1.0'));
  assert.ok(!updater.isNewer('garbage', '1.1.0'));
});

test('scan counts tokens once per message id across files', async () => {
  const root = fixture();
  const r = await logs.scan(root, {}, () => {});
  assert.strictEqual(r.agg.msgs, 3);
  const total = Object.values(r.agg.days).reduce((t, a) => t + a[0] + a[1] + a[2] + a[3], 0);
  assert.strictEqual(total, 3 * 1130);
  assert.strictEqual(r.agg.think, 1);
  assert.deepStrictEqual(r.agg.skills, { plan: 1 });
  assert.strictEqual(r.agg.sessions, 2, 'each non-subagent file with activity is a session');
  assert.strictEqual(r.agg.hours.reduce((a, b) => a + b, 0), 3 * 1130);
  assert.ok(Object.keys(r.agg.projects).includes('alpha'));
});

test('unchanged files come from the cache, changed ones are re-read', async () => {
  const root = fixture();
  const first = await logs.scan(root, {}, () => {});
  let progress = null;
  const second = await logs.scan(root, JSON.parse(JSON.stringify(first.files)), (p) => { progress = p; });
  assert.strictEqual(second.changed, false);
  assert.strictEqual(progress.total, 0, 'nothing should be re-read');
  assert.strictEqual(second.agg.msgs, first.agg.msgs);

  const file = path.join(root, '-Users-me-Projects-alpha', 'b.jsonl');
  fs.appendFileSync(file, reply('m4', '2026-03-04T09:00:00Z', { input_tokens: 5, output_tokens: 5 }));
  const third = await logs.scan(root, JSON.parse(JSON.stringify(first.files)), () => {});
  assert.strictEqual(third.changed, true);
  assert.strictEqual(third.agg.msgs, first.agg.msgs + 1);
});

test('empty folder gives no aggregate', async () => {
  const r = await logs.scan(tmp(), {}, () => {});
  assert.strictEqual(r.agg, null);
});

test('chat export is parsed and estimated', () => {
  const out = chat.parseExport([{
    name: 'Trip plan', created_at: '2026-02-01T08:00:00Z',
    chat_messages: [
      { sender: 'human', created_at: '2026-02-01T08:00:00Z', text: 'a'.repeat(370) },
      { sender: 'assistant', created_at: '2026-02-01T08:00:05Z', content: [{ type: 'text', text: 'b'.repeat(740) }] }
    ]
  }, { name: 'empty', chat_messages: [] }], 'x.zip');
  assert.strictEqual(out.conversations, 1);
  assert.strictEqual(out.msgs, 1);
  const day = Object.values(out.days)[0];
  assert.deepStrictEqual([day[0], day[1]], [100, 200]);
  assert.ok(out.projects['Trip plan']);
});

test('chat export zip is read through unzip', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify([{ name: 'z', chat_messages: [{ sender: 'human', created_at: '2026-02-01T08:00:00Z', text: 'hello there' }] }]));
  execFileSync('/usr/bin/zip', ['-j', path.join(dir, 'data.zip'), path.join(dir, 'conversations.json')], { stdio: 'ignore' });
  const out = await chat.readExport(path.join(dir, 'data.zip'));
  assert.strictEqual(out.conversations, 1);
  await assert.rejects(chat.readExport(path.join(dir, 'missing.zip')));
});

test('swap script replaces the bundle and keeps a rollback on failure', () => {
  const dir = tmp();
  const mk = (p, v) => { fs.mkdirSync(path.join(p, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(p, 'Contents', 'v'), v); };
  const target = path.join(dir, 'Token Trail.app'), next = path.join(dir, 'staged', 'app', 'Token Trail.app');
  mk(target, 'old'); mk(next, 'new');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, updater.SWAP_SCRIPT, { mode: 0o755 });
  execFileSync('/bin/sh', [script, '999999', next, target, '0']);
  assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'v'), 'utf8'), 'new');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.old-')), [], 'backup is cleaned up');

  /* A missing source must leave the installed app untouched. */
  execFileSync('/bin/sh', [script, '999999', path.join(dir, 'nope.app'), target, '0']);
  assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'v'), 'utf8'), 'new');
});

test('updater rejects a download that does not match the published checksum and cleans up', async () => {
  const dir = tmp();
  const app = { getVersion: () => '1.0.0', getPath: () => dir, isPackaged: false, on() {}, quit() {} };
  const body = Buffer.from('not the real zip');
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.github.com')) {
      return { ok: true, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test', body: '', assets: [{ name: 'T-9.9.9-' + process.arch + '.zip', browser_download_url: 'https://example.test/a.zip', size: body.length, digest: 'sha256:' + '0'.repeat(64) }] }) };
    }
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  try {
    const s = await updater.create({ app, shell: { openExternal() {} }, send() {} }).check(true);
    assert.strictEqual(s.state, 'error');
    assert.match(s.error, /Checksum mismatch/);
    assert.ok(!fs.existsSync(path.join(dir, 'update')), 'a failed download leaves nothing behind');
  } finally { global.fetch = realFetch; }
});
