(function () {
  var $ = function (s) { return document.querySelector(s); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var dk = function (t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var sum4 = function (a, incl) { return a ? a[0] + a[1] + (incl ? a[2] + a[3] : 0) : 0; };
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var WDAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var WDAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var api = window.api;

  function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }
  function dur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + pad(r) + 's';
    return Math.floor(m / 60) + 'h ' + pad(m % 60) + 'm';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function niceModel(n) { return n.replace(/^claude-/, '').replace(/-\d{8}$/, ''); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mb(n) { return (n / 1048576).toFixed(n > 1e8 ? 0 : 1) + ' MB'; }
  function money(n) { return n >= 1000 ? '$' + Math.round(n).toLocaleString() : '$' + n.toFixed(n >= 100 ? 0 : 2); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }

  /* ---------- combining sources ---------- */
  function merge(list) {
    var o = { days: {}, models: {}, projects: {}, skills: {}, msgs: 0, think: 0, fast: 0, sessions: 0, files: 0, conversations: 0, longest: { ms: 0, day: null }, hours: [], wdays: [] };
    var i;
    for (i = 0; i < 24; i++) o.hours.push(0);
    for (i = 0; i < 7; i++) o.wdays.push(0);
    list.forEach(function (s) {
      if (!s) return;
      ['days', 'models', 'projects'].forEach(function (k) {
        Object.keys(s[k] || {}).forEach(function (key) {
          var a = o[k][key] || (o[k][key] = [0, 0, 0, 0]);
          for (var j = 0; j < 4; j++) a[j] += s[k][key][j];
        });
      });
      Object.keys(s.skills || {}).forEach(function (k) { o.skills[k] = (o.skills[k] || 0) + s.skills[k]; });
      ['msgs', 'think', 'fast', 'sessions', 'files', 'conversations'].forEach(function (k) { o[k] += s[k] || 0; });
      if (s.longest && s.longest.ms > o.longest.ms) o.longest = s.longest;
      (s.hours || []).forEach(function (v, h) { o.hours[h] += v; });
      (s.wdays || []).forEach(function (v, d) { o.wdays[d] += v; });
    });
    return o;
  }

  /* Rough API-equivalent cost per million tokens: [input, output]. Cache writes cost 1.25x input and
     cache reads 0.1x input. Subscriptions are flat-rate, so this is a scale of use, not a bill. */
  function price(model) {
    var m = String(model).toLowerCase();
    if (m.indexOf('haiku') >= 0) return /3-5|3\.5|3-haiku/.test(m) ? [0.8, 4] : [1, 5];
    if (m.indexOf('sonnet') >= 0) return [3, 15];
    if (m.indexOf('opus') >= 0) return /opus-4-1|opus-4-2025|3-opus/.test(m) ? [15, 75] : [5, 25];
    return null;
  }
  function cost(models) {
    var total = 0, unpriced = 0;
    Object.keys(models).forEach(function (k) {
      var p = price(k), a = models[k];
      if (k === 'Claude chat') return;
      if (!p) { unpriced += a[0] + a[1] + a[2] + a[3]; return; }
      total += (a[0] * p[0] + a[1] * p[1] + a[2] * p[0] * 1.25 + a[3] * p[0] * 0.1) / 1e6;
    });
    return { usd: total, unpriced: unpriced };
  }

  /* ---------- profile ---------- */
  function initials(n) {
    var p = n.trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  async function loadProfile() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem('cp:profile') || 'null'); } catch (e) {}
    if (!p) {
      try { var w = await api.whoami(); p = { name: w.name, handle: w.handle }; }
      catch (e) { p = { name: 'You', handle: '@you' }; }
    }
    $('#name').value = p.name; $('#handle').value = p.handle;
    $('#avatar').textContent = initials($('#name').value);
  }
  function saveProfile() {
    $('#avatar').textContent = initials($('#name').value);
    try { localStorage.setItem('cp:profile', JSON.stringify({ name: $('#name').value, handle: $('#handle').value })); } catch (e) {}
  }
  $('#name').addEventListener('input', saveProfile);
  $('#handle').addEventListener('input', saveProfile);

  /* ---------- state ---------- */
  var DATA = { code: null, chat: null }, SRC = 'all', VIEW = 'daily', V = null, ERR = null, busy = false;
  try { SRC = localStorage.getItem('tt:src') || 'all'; } catch (e) {}
  var lastScan = 0;

  function sources() { return SRC === 'code' ? [DATA.code] : SRC === 'chat' ? [DATA.chat] : [DATA.code, DATA.chat]; }

  function applyState(s) {
    DATA.code = s.code || null; DATA.chat = s.chat || null;
    ERR = s.error ? { error: s.error, dir: s.dir } : null;
    if (!DATA.code && DATA.chat && SRC !== 'chat') SRC = 'chat';
    show();
  }

  function show() {
    if (!DATA.code && !DATA.chat) return;
    $('#loader').hidden = true;
    $('#seg').hidden = false;
    $('#srcline').hidden = false;
    document.querySelectorAll('#seg button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-s') === SRC ? 'true' : 'false'); });
    $('#importbtn').textContent = DATA.chat ? 'Re-import chat export…' : 'Import chat export…';
    var rm = $('#rmchat');
    if (rm) rm.hidden = !DATA.chat;

    var parts = [], stamp = 0;
    if (DATA.code) { parts.push(plural(DATA.code.files, 'session file')); stamp = Math.max(stamp, DATA.code.savedAt || 0); }
    if (DATA.chat) { parts.push(plural(DATA.chat.conversations, 'chat')); stamp = Math.max(stamp, DATA.chat.importedAt || 0); }
    $('#srctext').textContent = busy ? 'Updating…' : parts.join(' · ') + ' · updated ' + new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    var any = sources().some(Boolean);
    $('#dash').hidden = !any;
    $('#empty').hidden = any;
    if (any) render(); else fillEmpty();
  }

  function fillEmpty() {
    var chat = SRC === 'chat';
    $('#et').textContent = chat ? 'Add your Claude chat usage' : 'No Claude Code usage found';
    $('#ep').textContent = chat
      ? 'Chats in the Claude app are not stored on your Mac, so Token Trail reads the data export Anthropic gives you. The export has no token counts, so chat tokens are estimated from message length.'
      : (ERR && ERR.dir ? 'Nothing was found in ' + ERR.dir + '. Run Claude Code once, or choose the folder it uses.' : 'Run Claude Code once, or choose the folder it uses.');
    $('#esteps').hidden = !chat;
    $('#elink').hidden = !chat;
    $('#ebtn').textContent = chat ? 'Import chat export…' : 'Choose projects folder';
    $('#ebtn').onclick = chat ? importChat : choose;
  }

  /* ---------- rendering ---------- */
  function dayDiff(a, b) {
    var p = a.split('-'), q = b.split('-');
    return Math.round((Date.UTC(+q[0], +q[1] - 1, +q[2]) - Date.UTC(+p[0], +p[1] - 1, +p[2])) / 864e5);
  }
  function streaks(agg) {
    var keys = Object.keys(agg.days).filter(function (k) { return sum4(agg.days[k], true) > 0; }).sort();
    var best = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      run = (prev && dayDiff(prev, k) === 1) ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    });
    var cur = (prev && dayDiff(prev, dk(Date.now())) <= 1) ? run : 0;
    return { best: best, cur: cur };
  }
  function grid() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var start = new Date(today); start.setDate(start.getDate() - today.getDay() - 52 * 7);
    return { today: today, start: start };
  }
  function lastDays(agg, n, incl) {
    var t = 0, d = new Date();
    for (var i = 0; i < n; i++) { t += sum4(agg.days[dk(d.getTime())], incl); d.setDate(d.getDate() - 1); }
    return t;
  }

  function render() {
    var agg = V = merge(sources()), incl = $('#cache').checked;
    var chatOnly = SRC === 'chat', hasChat = !!DATA.chat && SRC !== 'code';
    $('#cache').parentNode.hidden = chatOnly;
    var total = 0, peak = 0, peakDay = null, activeDays = 0;
    Object.keys(agg.days).forEach(function (k) {
      var v = sum4(agg.days[k], incl); total += v;
      if (v > 0) activeDays++;
      if (v > peak) { peak = v; peakDay = k; }
    });
    var sk = streaks(agg);
    var cells = [
      [fmt(total), 'Lifetime tokens'], [fmt(peak), 'Peak day'],
      chatOnly ? [agg.conversations.toLocaleString(), 'Conversations'] : [dur(agg.longest.ms), 'Longest task'],
      [plural(sk.best, 'day'), 'Longest streak'], [plural(sk.cur, 'day'), 'Current streak']
    ];
    $('#strip').innerHTML = cells.map(function (c) { return '<div class="cell"><b>' + esc(c[0]) + '</b><span>' + c[1] + '</span></div>'; }).join('');
    $('#strip').firstChild.title = chatOnly ? 'Estimated from message length' : incl ? 'Input, output and cache tokens' : 'Input and output tokens only';

    var c = cost(agg.models);
    var recent = [
      [fmt(lastDays(agg, 1, incl)), 'Today'], [fmt(lastDays(agg, 7, incl)), 'Last 7 days'], [fmt(lastDays(agg, 30, incl)), 'Last 30 days'],
      chatOnly ? [agg.msgs.toLocaleString(), 'Replies from Claude'] : [c.usd > 0 ? '~' + money(c.usd) : 'n/a', 'API-equivalent value']
    ];
    $('#recent').innerHTML = recent.map(function (r, i) {
      var tip = i === 3 ? ' title="What this usage would cost at public API prices, cache included. A rough scale, not your bill; subscriptions are flat-rate."' : '';
      return '<div' + tip + '><span>' + r[1] + '</span><b>' + esc(r[0]) + '</b></div>';
    }).join('');

    var note = $('#note');
    note.hidden = !hasChat;
    note.textContent = 'Chat tokens are estimated from message length because the Claude export has no token counts.';

    $('#projh').textContent = chatOnly ? 'Top conversations' : SRC === 'all' && DATA.chat ? 'Top projects and chats' : 'Top projects';
    drawChart(incl);

    function ranked(map, el) {
      var rows = Object.keys(map).map(function (k) { return [k, sum4(map[k], incl)]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
      var mx = rows.length ? rows[0][1] || 1 : 1;
      $(el).innerHTML = rows.map(function (r) {
        return '<li><span class="n" title="' + esc(r[0]) + '">' + esc(el === '#models' ? niceModel(r[0]) : r[0]) + '</span><span class="v mono">' + fmt(r[1]) + '</span><span class="t"><i style="width:' + Math.max(2, Math.round(r[1] / mx * 100)) + '%"></i></span></li>';
      }).join('') || '<li class="v">No data</li>';
    }
    ranked(agg.models, '#models'); ranked(agg.projects, '#projects');
    patterns(agg);

    var skillNames = Object.keys(agg.skills), skillUses = skillNames.reduce(function (t, k) { return t + agg.skills[k]; }, 0);
    var pct = function (n) { return agg.msgs ? Math.round(n / agg.msgs * 100) : 0; };
    var peakText = peakDay ? new Date(peakDay + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'None';
    var rows;
    if (chatOnly) {
      rows = [
        ['Conversations', agg.conversations.toLocaleString(), false],
        ['Replies from Claude', agg.msgs.toLocaleString(), false],
        ['Active days', String(activeDays), false],
        ['Average per active day', activeDays ? fmt(total / activeDays) : 'None', false],
        ['Peak day', peakText, false],
        ['Imported', DATA.chat ? new Date(DATA.chat.importedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + (DATA.chat.from ? ' from ' + DATA.chat.from : '') : 'None', false]
      ];
    } else {
      rows = [
        ['Fast mode', agg.fast ? pct(agg.fast) + '% of replies' : 'Not used', !agg.fast],
        ['Extended thinking', pct(agg.think) + '% of replies', false],
        ['Skills explored', String(skillNames.length), false],
        ['Total skills used', String(skillUses), false],
        ['Active days', String(activeDays), false],
        ['Average per active day', activeDays ? fmt(total / activeDays) : 'None', false],
        ['Sessions', String(agg.sessions), false],
        ['Replies from Claude', agg.msgs.toLocaleString(), false],
        ['Peak day', peakText, false]
      ];
      if (SRC === 'all' && DATA.chat) rows.splice(7, 0, ['Chat conversations', DATA.chat.conversations.toLocaleString(), false]);
    }
    if (c.unpriced > 0) rows.push(['Not in the value estimate', fmt(c.unpriced) + ' tokens from models without a known price', true]);
    $('#ins').innerHTML = rows.map(function (r) {
      return '<li><span class="k">' + r[0] + '</span><span class="val' + (r[2] ? ' dim' : '') + '">' + esc(r[1]) + '</span></li>';
    }).join('');

    $('#foot').textContent = chatOnly
      ? 'Chat usage comes from your claude.ai data export and is estimated from message length. Re-import a newer export any time to refresh it.'
      : 'Claude Code usage is read from the logs on this Mac. A task is one prompt and everything Claude did until your next prompt, with waits over 15 minutes trimmed.' + (DATA.chat ? ' Chat tokens are estimated.' : ' Chats in the Claude app are not in these logs; import a data export to include them.');
  }

  function bars(el, arr, tip) {
    var mx = Math.max.apply(null, arr) || 1;
    el.innerHTML = arr.map(function (v, i) {
      return '<div title="' + esc(tip(i, v)) + '"><i class="' + (v === mx && v > 0 ? 'peak' : '') + '" style="height:' + Math.max(2, Math.round(v / mx * 100)) + '%"></i></div>';
    }).join('');
  }
  function hourName(h) { return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM'); }
  function patterns(agg) {
    var sw = agg.wdays.reduce(function (a, b) { return a + b; }, 0), sh = agg.hours.reduce(function (a, b) { return a + b; }, 0);
    bars($('#wday'), agg.wdays, function (i, v) { return WDAY_FULL[i] + ': ' + fmt(v) + ' tokens'; });
    $('#wdayl').innerHTML = WDAY.map(function (d) { return '<span>' + d.slice(0, 1) + '</span>'; }).join('');
    $('#wdays').textContent = sw ? 'Busiest on ' + WDAY_FULL[agg.wdays.indexOf(Math.max.apply(null, agg.wdays))] + 's.' : 'Not enough data yet.';
    bars($('#hour'), agg.hours, function (i, v) { return hourName(i) + ': ' + fmt(v) + ' tokens'; });
    $('#hourl').innerHTML = ['12a', '6a', '12p', '6p'].map(function (l) { return '<span style="flex:6;text-align:left">' + l + '</span>'; }).join('');
    $('#hours').textContent = sh ? 'Most active around ' + hourName(agg.hours.indexOf(Math.max.apply(null, agg.hours))) + '.' : 'Not enough data yet.';
  }

  function drawChart(incl) {
    var agg = V, g = grid(), box = $('#chartbox'), legend = $('#legend');
    var val = function (k) { return sum4(agg.days[k], incl); };
    var weekStarts = [], i;
    for (i = 0; i < 53; i++) { var d = new Date(g.start); d.setDate(d.getDate() + i * 7); weekStarts.push(d); }
    var labels = [], lastM = -1;
    weekStarts.forEach(function (d, w) { if (d.getMonth() !== lastM) { labels.push([w, MON[d.getMonth()]]); lastM = d.getMonth(); } });

    /* The total under the heading covers the same 53 weeks the charts show. */
    var rangeTotal = 0;
    weekStarts.forEach(function (ws) {
      for (var j = 0; j < 7; j++) { var x = new Date(ws); x.setDate(x.getDate() + j); if (x <= g.today) rangeTotal += val(dk(x.getTime())) || 0; }
    });
    Heat.setTotal($('#heatnum'), fmt(rangeTotal));

    if (VIEW === 'daily') {
      Heat.draw({ agg: agg, incl: incl, chatOnly: SRC === 'chat', grid: g, fmt: fmt, sum4: sum4, dk: dk, sig: SRC + ':' + incl });
      return;
    }
    Heat.reset();
    legend.innerHTML = '';
    var wk = weekStarts.map(function (ws) {
      var t = 0;
      for (var j = 0; j < 7; j++) { var x = new Date(ws); x.setDate(x.getDate() + j); if (x <= g.today) t += val(dk(x.getTime())) || 0; }
      return t;
    });
    var series = wk;
    if (VIEW === 'cum') { var run = 0; series = wk.map(function (v) { run += v; return run; }); }
    var mx = Math.max.apply(null, series) || 1;
    var mag = Math.pow(10, Math.floor(Math.log10(mx)));
    var top = Math.ceil(mx / mag) * mag;
    var W = 900, H = 230, L = 52, R = 10, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    var X = function (n) { return L + (n + 0.5) / 53 * pw; };
    var Y = function (v) { return T + ph - v / top * ph; };
    var out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (VIEW === 'cum' ? 'Cumulative' : 'Weekly') + ' token chart">';
    [0, 0.5, 1].forEach(function (f) {
      var y = Y(top * f);
      out += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + fmt(top * f) + '</text>';
    });
    if (VIEW === 'weekly') {
      var bw = pw / 53 * 0.7;
      series.forEach(function (v, n) {
        if (v > 0) out += '<rect class="bar-m" x="' + (X(n) - bw / 2) + '" y="' + Y(v) + '" width="' + bw + '" height="' + (T + ph - Y(v)) + '" rx="2"><title>Week of ' + weekStarts[n].toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ': ' + fmt(v) + ' tokens</title></rect>';
      });
    } else {
      var pts = series.map(function (v, n) { return X(n) + ',' + Y(v); });
      out += '<polygon class="area-m" points="' + X(0) + ',' + (T + ph) + ' ' + pts.join(' ') + ' ' + X(52) + ',' + (T + ph) + '"/><polyline class="line-m" points="' + pts.join(' ') + '"/><circle class="dot-m" cx="' + X(52) + '" cy="' + Y(series[52]) + '" r="4"/>';
    }
    labels.forEach(function (m) { out += '<text x="' + X(m[0]) + '" y="' + (H - 6) + '">' + m[1] + '</text>'; });
    box.innerHTML = out + '</svg>';
  }

  /* ---------- scanning ---------- */
  function loaderState(title, text, needPick, err) {
    $('#loader').hidden = false; $('#dash').hidden = true; $('#empty').hidden = true; $('#srcline').hidden = true; $('#seg').hidden = true;
    $('#lt').textContent = title; $('#lp').textContent = text;
    $('#pickbtn').hidden = !needPick; $('#chatbtn').hidden = !needPick;
    $('#bar').hidden = needPick; $('#hint').hidden = true;
    $('#barfill').style.width = '0';
    $('#msg').textContent = '';
    $('#msg').className = 'msg' + (err ? ' err' : '');
  }
  api.onProgress(function (p) {
    var pct = p.total ? p.bytes / p.total : 1;
    if (DATA.code || DATA.chat) { if (busy) $('#srctext').textContent = 'Updating… ' + Math.round(pct * 100) + '%'; return; }
    $('#barfill').style.width = Math.round(pct * 100) + '%';
    $('#msg').textContent = p.total
      ? 'Reading ' + mb(p.bytes) + ' of ' + mb(p.total) + ' · file ' + p.i + ' of ' + p.n + ' · ' + fmt(p.tokens) + ' tokens so far'
      : 'Loading ' + p.n + ' files from cache · ' + fmt(p.tokens) + ' tokens so far';
  });

  async function runScan() {
    if (busy) return;
    busy = true;
    var first = !DATA.code && !DATA.chat;
    if (first) loaderState('Reading your Claude Code history', 'Scanning your projects folder. The first scan is the slow one.', false);
    else $('#srctext').textContent = 'Updating…';
    var hint = setTimeout(function () { if (!DATA.code && !DATA.chat) $('#hint').hidden = false; }, 6000);
    try {
      var r = await api.scan();
      lastScan = Date.now();
      busy = false;
      if (!r.code && !r.chat) {
        if (r.error === 'nofolder') loaderState('Find your Claude Code folder', 'No folder was found at ' + r.dir + '. Choose the projects folder inside .claude (press Cmd + Shift + . to show hidden folders), or import your Claude chat export instead.', true);
        else loaderState('No usage found yet', 'The folder ' + r.dir + ' has no Claude Code sessions yet. Run Claude Code once, then rescan, or import your Claude chat export.', true);
      } else applyState(r);
    } catch (e) {
      busy = false;
      if (DATA.code || DATA.chat) show();
      else { loaderState('Something went wrong', String((e && e.message) || e), true, true); }
    }
    clearTimeout(hint);
    busy = false;
  }

  async function choose() { var ok = await api.chooseFolder(); if (ok) { DATA.code = null; runScan(); } }
  async function importChat() {
    var r = await api.importChat();
    if (r.canceled) return;
    if (r.error) { toast(r.error); return; }
    DATA.chat = r.chat;
    if (SRC === 'code') SRC = 'all';
    try { localStorage.setItem('tt:src', SRC); } catch (e) {}
    show();
    toast('Imported ' + plural(r.chat.conversations, 'conversation') + '. Chat tokens are estimates.');
  }

  /* A button for removing imported chat data, created here so the header stays uncluttered when there is none. */
  (function () {
    var b = document.createElement('button');
    b.className = 'btn'; b.id = 'rmchat'; b.type = 'button'; b.hidden = true; b.textContent = 'Remove chat data';
    b.addEventListener('click', async function () {
      await api.removeChat(); DATA.chat = null;
      if (SRC === 'chat') SRC = 'all';
      if (!DATA.code) { loaderState('No usage found yet', 'Chat data was removed and no Claude Code usage was found. Choose a folder or import an export.', true); return; }
      show(); toast('Chat data removed.');
    });
    $('#srcline').appendChild(b);
  })();

  /* ---------- export ---------- */
  function csv() {
    var rows = [['date', 'source', 'input', 'output', 'cache_write', 'cache_read', 'total']];
    [['claude_code', DATA.code], ['claude_chat_estimated', DATA.chat]].forEach(function (s) {
      if (!s[1]) return;
      Object.keys(s[1].days).sort().forEach(function (k) {
        var a = s[1].days[k];
        rows.push([k, s[0], a[0], a[1], a[2], a[3], a[0] + a[1] + a[2] + a[3]]);
      });
    });
    return rows.map(function (r) { return r.join(','); }).join('\n') + '\n';
  }

  /* ---------- updates ---------- */
  function renderUpdate(s) {
    if (!s) return;
    $('#ver').textContent = 'Token Trail v' + s.current;
    var msg = '';
    if (s.state === 'checking') msg = 'Checking…';
    else if (s.state === 'current') msg = 'You are up to date.';
    else if (s.state === 'error') msg = 'Could not check: ' + s.error;
    $('#chkmsg').textContent = msg;
    $('#chk').disabled = s.state === 'checking' || s.state === 'downloading';

    var b = $('#update'), btn = $('#updbtn'), sub = $('#updsub'), bar = $('#updbar');
    var visible = s.state === 'available' || s.state === 'downloading' || s.state === 'ready';
    b.hidden = !visible;
    if (!visible) return;
    bar.hidden = s.state !== 'downloading';
    $('#updfill').style.width = Math.round((s.progress || 0) * 100) + '%';
    sub.hidden = !(s.notes && s.state !== 'downloading');
    sub.textContent = (s.notes || '').split('\n').map(function (l) { return l.replace(/^[\s#>*-]+/, '').replace(/[*`]/g, '').trim(); }).filter(Boolean).slice(0, 2).join(' · ').slice(0, 160);
    btn.hidden = false;
    if (s.state === 'downloading') {
      $('#updtext').textContent = 'Downloading Token Trail ' + s.version + '… ' + Math.round((s.progress || 0) * 100) + '%';
      btn.hidden = true;
    } else if (s.state === 'ready') {
      $('#updtext').textContent = 'Token Trail ' + s.version + ' is ready.';
      btn.textContent = s.installable ? 'Restart to update' : 'Get the update';
      btn.onclick = function () { api.update.install(); };
    } else {
      $('#updtext').textContent = 'Token Trail ' + s.version + ' is available.';
      btn.textContent = 'View release';
      btn.onclick = function () { api.openExternal(s.page); };
    }
  }

  /* ---------- wiring ---------- */
  $('#cache').addEventListener('change', function () { if (V) render(); });
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      VIEW = b.getAttribute('data-v');
      document.querySelectorAll('.tab').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      if (V) drawChart($('#cache').checked);
    });
  });
  document.querySelectorAll('#seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      SRC = b.getAttribute('data-s');
      try { localStorage.setItem('tt:src', SRC); } catch (e) {}
      show();
    });
  });
  $('#pickbtn').addEventListener('click', choose);
  $('#chatbtn').addEventListener('click', importChat);
  $('#clear').addEventListener('click', choose);
  $('#importbtn').addEventListener('click', importChat);
  $('#reload').addEventListener('click', runScan);
  $('#elink').addEventListener('click', function () { api.openExternal('https://claude.ai/settings/data-privacy-controls'); });
  $('#chk').addEventListener('click', function () { api.update.check(); });
  $('#csv').addEventListener('click', async function () {
    if (!DATA.code && !DATA.chat) { toast('Nothing to export yet.'); return; }
    if (await api.saveCsv(csv(), 'token-trail-usage.csv')) toast('Saved your daily usage as CSV.');
  });
  $('#login').addEventListener('change', async function () { $('#login').checked = await api.login.set($('#login').checked); });
  window.addEventListener('focus', function () { if ((DATA.code || DATA.chat) && Date.now() - lastScan > 60000) runScan(); });
  api.onState(function (s) { if (busy) return; lastScan = Date.now(); if (s.code || s.chat) applyState(s); });
  api.onMenu(function (what) { if (what === 'rescan') runScan(); else importChat(); });
  api.update.onState(renderUpdate);

  Heat.init({ box: $('#chartbox'), legend: $('#legend'), tip: $('#tip'), info: $('#dayinfo'), scroller: document.querySelector('.scroll') });
  loadProfile();
  api.update.get().then(renderUpdate);
  api.login.get().then(function (on) { $('#login').checked = !!on; });
  (async function () {
    var cached = await api.cached();
    if (cached && (cached.code || cached.chat)) applyState(cached);
    runScan();
  })();
})();
