
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var dk = function (t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var sum4 = function (a, incl) { return a ? a[0] + a[1] + (incl ? a[2] + a[3] : 0) : 0; };
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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

  function emptyAgg() {
    return { days: {}, models: {}, projects: {}, skills: {}, msgs: 0, think: 0, fast: 0, sessions: 0, files: 0, longest: { ms: 0, day: null }, source: 'logs', savedAt: Date.now() };
  }
  function add4(map, key, v) {
    var a = map[key] || (map[key] = [0, 0, 0, 0]);
    for (var i = 0; i < 4; i++) a[i] += v[i];
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
      try { var w = await window.api.whoami(); p = { name: w.name, handle: w.handle }; }
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

  /* ---------- rendering ---------- */
  var AGG = null, VIEW = 'daily';

  var lastScan = 0;
  function setAgg(agg, updating) {
    AGG = agg;
    $('#loader').hidden = true;
    $('#dash').hidden = false;
    $('#srcline').hidden = false;
    $('#srctext').textContent = updating ? 'Updating…' : plural(agg.files, 'session file') + ' · updated ' + new Date(agg.savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    render();
  }

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

  function render() {
    var agg = AGG, incl = $('#cache').checked;
    var total = 0, peak = 0, peakDay = null;
    Object.keys(agg.days).forEach(function (k) {
      var v = sum4(agg.days[k], incl); total += v;
      if (v > peak) { peak = v; peakDay = k; }
    });
    var sk = streaks(agg);
    var cells = [
      [fmt(total), 'Lifetime tokens'], [fmt(peak), 'Peak day'], [dur(agg.longest.ms), 'Longest task'],
      [plural(sk.best, 'day'), 'Longest streak'], [plural(sk.cur, 'day'), 'Current streak']
    ];
    $('#strip').innerHTML = cells.map(function (c) { return '<div class="cell"><b>' + esc(c[0]) + '</b><span>' + c[1] + '</span></div>'; }).join('');
    $('#strip').firstChild.title = incl ? 'Input, output and cache tokens' : 'Input and output tokens only';

    drawChart(incl);

    function ranked(map, el) {
      var rows = Object.keys(map).map(function (k) { return [k, sum4(map[k], incl)]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
      var mx = rows.length ? rows[0][1] || 1 : 1;
      $(el).innerHTML = rows.map(function (r) {
        return '<li><span class="n">' + esc(el === '#models' ? niceModel(r[0]) : r[0]) + '</span><span class="v mono">' + fmt(r[1]) + '</span><span class="t"><i style="width:' + Math.max(2, Math.round(r[1] / mx * 100)) + '%"></i></span></li>';
      }).join('') || '<li class="v">No data</li>';
    }
    ranked(agg.models, '#models'); ranked(agg.projects, '#projects');

    var skillNames = Object.keys(agg.skills), skillUses = skillNames.reduce(function (t, k) { return t + agg.skills[k]; }, 0);
    var activeDays = Object.keys(agg.days).length;
    var pct = function (n) { return agg.msgs ? Math.round(n / agg.msgs * 100) : 0; };
    var rows = [
      ['Fast mode', agg.fast ? pct(agg.fast) + '% of replies' : 'Not used', !agg.fast],
      ['Extended thinking', pct(agg.think) + '% of replies', false],
      ['Skills explored', String(skillNames.length), false],
      ['Total skills used', String(skillUses), false],
      ['Active days', String(activeDays), false],
      ['Sessions', String(agg.sessions), false],
      ['Replies from Claude', agg.msgs.toLocaleString(), false],
      ['Peak day', peakDay ? new Date(peakDay + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'None', false]
    ];
    $('#ins').innerHTML = rows.map(function (r) {
      return '<li><span class="k">' + r[0] + '</span><span class="val' + (r[2] ? ' dim' : '') + '">' + esc(r[1]) + '</span></li>';
    }).join('');
  }

  function drawChart(incl) {
    var agg = AGG, g = grid(), box = $('#chartbox'), legend = $('#legend');
    var val = function (k) { return sum4(agg.days[k], incl); };
    var weekStarts = [], i;
    for (i = 0; i < 53; i++) { var d = new Date(g.start); d.setDate(d.getDate() + i * 7); weekStarts.push(d); }
    var labels = [], lastM = -1;
    weekStarts.forEach(function (d, w) { if (d.getMonth() !== lastM) { labels.push([w, MON[d.getMonth()]]); lastM = d.getMonth(); } });

    if (VIEW === 'daily') {
      var vals = [], cells = [];
      for (i = 0; i < 53 * 7; i++) {
        var dd = new Date(g.start); dd.setDate(dd.getDate() + i);
        var fut = dd > g.today, v = fut ? -1 : (val(dk(dd.getTime())) || 0);
        cells.push([dd, v]); if (v > 0) vals.push(v);
      }
      vals.sort(function (a, b) { return a - b; });
      var q = function (p) { return vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0; };
      var t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
      var html = '<div class="heat">' + cells.map(function (c) {
        var v = c[1], l = v < 0 ? 'x' : v === 0 ? '0' : v <= t1 ? '1' : v <= t2 ? '2' : v <= t3 ? '3' : '4';
        var tip = v < 0 ? '' : ' title="' + c[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ': ' + fmt(Math.max(v, 0)) + ' tokens"';
        return '<i data-l="' + l + '"' + tip + '></i>';
      }).join('') + '</div><div class="months">' + labels.map(function (m) { return '<span style="grid-column:' + (m[0] + 1) + ' / span 4">' + m[1] + '</span>'; }).join('') + '</div>';
      box.innerHTML = html;
      legend.innerHTML = 'Less <i style="background:var(--h0)"></i><i style="background:var(--h1)"></i><i style="background:var(--h2)"></i><i style="background:var(--h3)"></i><i style="background:var(--h4)"></i> More';
      return;
    }
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

  /* ---------- wiring ---------- */
  var api = window.api;
  var scanning = false;
  function loaderState(title, text, needPick, err) {
    $('#loader').hidden = false; $('#dash').hidden = true; $('#srcline').hidden = true;
    $('#lt').textContent = title; $('#lp').textContent = text;
    $('#pickbtn').hidden = !needPick;
    $('#bar').hidden = needPick;
    $('#msg').className = 'msg' + (err ? ' err' : '');
  }
  api.onProgress(function (p) {
    if (AGG) { $('#srctext').textContent = 'Updating… ' + p.i + ' of ' + p.n; return; }
    $('#barfill').style.width = Math.round(p.i / p.n * 100) + '%';
    $('#msg').textContent = 'Reading file ' + p.i + ' of ' + p.n + ' · ' + fmt(p.tokens) + ' tokens so far';
  });
  async function runScan() {
    if (scanning) return;
    scanning = true;
    if (AGG) $('#srctext').textContent = 'Updating…';
    else loaderState('Reading your Claude Code history', 'Scanning your projects folder. This only takes a moment.', false);
    try {
      var r = await api.scan();
      if (r.error === 'nofolder') {
        loaderState('Find your Claude Code folder', 'No folder was found at ' + r.dir + '. Choose the projects folder inside .claude (press Cmd + Shift + . to show hidden folders). You only need to do this once.', true);
      } else if (r.error === 'empty') {
        loaderState('No usage found yet', 'The folder ' + r.dir + ' has no Claude Code sessions. Run Claude Code once, then rescan.', true);
        $('#msg').className = 'msg err';
      } else {
        lastScan = Date.now();
        setAgg(r.agg);
      }
    } catch (e) {
      if (AGG) setAgg(AGG);
      else { loaderState('Something went wrong', String(e && e.message || e), true, true); }
    }
    scanning = false;
  }
  $('#cache').addEventListener('change', function () { if (AGG) render(); });
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      VIEW = b.getAttribute('data-v');
      document.querySelectorAll('.tab').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      if (AGG) drawChart($('#cache').checked);
    });
  });
  async function choose() { var ok = await api.chooseFolder(); if (ok) { AGG = null; runScan(); } }
  $('#pickbtn').addEventListener('click', choose);
  $('#clear').addEventListener('click', choose);
  $('#reload').addEventListener('click', runScan);
  window.addEventListener('focus', function () { if (AGG && Date.now() - lastScan > 60000) runScan(); });

  loadProfile();
  (async function () {
    var cached = await api.cached();
    if (cached) setAgg(cached, true);
    runScan();
  })();
})();
