/* Daily activity heatmap. One square per day, weeks as columns, five tints.
   Waves in once when scrolled into view, recolors in a sweep when the data source changes, and has one
   tooltip that glides between cells. Arrow keys move between days, Enter selects, the legend previews
   and pins a level. Exposed as window.Heat; renderer.js owns the data and calls draw(). */
(function () {
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var WD = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var COLS = 53, CELLS = COLS * 7, WAVE = 420;
  var LONG = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  var SHORT = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };

  var S = {
    el: null, key: null, els: [], dates: [], index: {}, last: 0, focus: -1,
    sig: null, legendSig: null, ranges: [], perLevel: [0, 0, 0, 0, 0],
    selected: null, pinned: null, preview: null, previewTimer: 0, hideTimer: 0, waveTimer: 0,
    revealed: false, observer: null, ctx: null, tipCell: null, tipOpen: false, tipValue: 0,
    totalText: null
  };
  var N = {};

  function init(nodes) {
    N = nodes;
    var box = N.box, legend = N.legend;
    box.addEventListener('pointerover', function (e) { var c = cellOf(e.target); if (c) showTip(c); });
    box.addEventListener('pointerleave', function (e) {
      var focused = cellOf(document.activeElement);
      if (focused && focused.matches(':focus-visible')) showTip(focused);
      else hideSoon(e.pointerType === 'touch' ? 2400 : 110);
    });
    box.addEventListener('focusin', function (e) {
      var c = cellOf(e.target);
      if (!c) return;
      setFocusable(+c.dataset.i);
      showTip(c);
    });
    box.addEventListener('focusout', function (e) { if (!box.contains(e.relatedTarget)) hideSoon(0); });
    box.addEventListener('keydown', onKey);
    box.addEventListener('click', function (e) { var c = cellOf(e.target); if (c) select(+c.dataset.i); });
    if (N.scroller) N.scroller.addEventListener('scroll', function () { if (S.tipOpen && S.tipCell) place(S.tipCell, false); }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(function () { placeRing(); if (S.tipOpen && S.tipCell) place(S.tipCell, false); }).observe(box);

    legend.addEventListener('pointerover', function (e) { var b = e.target.closest('.swb'); if (b) setPreview(+b.dataset.lv); });
    legend.addEventListener('pointerout', function (e) { if (e.target.closest('.swb')) setPreview(null); });
    legend.addEventListener('focusin', function (e) { var b = e.target.closest('.swb'); if (b) setPreview(+b.dataset.lv); });
    legend.addEventListener('focusout', function (e) { if (e.target.closest('.swb')) setPreview(null); });
    legend.addEventListener('click', function (e) {
      var b = e.target.closest('.swb');
      if (!b) return;
      var lv = +b.dataset.lv;
      S.pinned = S.pinned === lv ? null : lv;
      applyHighlight();
    });
    legend.addEventListener('keydown', function (e) {
      var b = e.target.closest('.swb');
      if (!b) return;
      var moves = { ArrowLeft: +b.dataset.lv - 1, ArrowRight: +b.dataset.lv + 1, Home: 0, End: 4 };
      if (!(e.key in moves)) return;
      e.preventDefault();
      var next = legend.querySelector('[data-lv="' + Math.min(Math.max(moves[e.key], 0), 4) + '"]');
      if (next) next.focus();
    });
  }

  function cellOf(node) {
    var c = node && node.closest ? node.closest('i[data-i]') : null;
    return c && N.box.contains(c) && c.dataset.l !== 'x' ? c : null;
  }

  /* ---------- building ---------- */
  function build(g, key) {
    var step = Math.min(12, WAVE / (COLS - 1 + 6));
    var html = '<div class="heat" role="grid" aria-label="Daily token usage, one square per day" aria-readonly="true" data-reveal="hidden">';
    for (var row = 0; row < 7; row++) {
      html += '<div class="hrow" role="row"><span class="wd" aria-hidden="true">' + WD[row] + '</span>';
      for (var col = 0; col < COLS; col++) {
        html += '<i role="gridcell" data-i="' + (col * 7 + row) + '" tabindex="-1" style="--wave:' + Math.round((col + row) * step) + 'ms"></i>';
      }
      html += '</div>';
    }
    html += '<span class="ring" aria-hidden="true"></span></div><div class="months" aria-hidden="true">';
    var lastM = -1;
    for (var w = 0; w < COLS; w++) {
      var d = new Date(g.start); d.setDate(d.getDate() + w * 7);
      if (d.getMonth() !== lastM) { html += '<span style="grid-column:' + (w + 2) + ' / ' + Math.min(w + 6, COLS + 2) + '">' + MON[d.getMonth()] + '</span>'; lastM = d.getMonth(); }
    }
    N.box.innerHTML = html + '</div>';

    S.el = N.box.querySelector('.heat');
    S.els = []; S.dates = []; S.index = {};
    N.box.querySelectorAll('i[data-i]').forEach(function (el) { S.els[+el.dataset.i] = el; });
    for (var i = 0; i < CELLS; i++) {
      var dt = new Date(g.start); dt.setDate(dt.getDate() + i);
      S.dates[i] = dt;
      S.index[dateKey(dt)] = i;
    }
    S.key = key;
    S.focus = -1;
    S.sig = null;
    if (S.revealed) S.el.dataset.reveal = 'done';
    else watchReveal();
  }

  function dateKey(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  function watchReveal() {
    if (REDUCED || !window.IntersectionObserver) { S.revealed = true; S.el.dataset.reveal = 'done'; return; }
    if (S.observer) S.observer.disconnect();
    window.clearTimeout(S.revealTimer);
    var el = S.el;
    S.observer = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      S.observer.disconnect();
      window.clearTimeout(S.revealTimer);
      S.revealed = true;
      el.classList.add('wave');
      requestAnimationFrame(function () {
        el.dataset.reveal = 'in';
        window.clearTimeout(S.waveTimer);
        S.waveTimer = window.setTimeout(function () { el.classList.remove('wave'); el.dataset.reveal = 'done'; }, WAVE + 700);
      });
    }, { threshold: 0.35 });
    S.observer.observe(el);
    /* Safety net: if the grid is on screen but the observer never fires (a window that is not painting),
       show it plainly rather than leave it invisible. */
    var checks = 0;
    (function check() {
      S.revealTimer = window.setTimeout(function () {
        if (S.revealed || S.el !== el) return;
        var r = el.getBoundingClientRect();
        if (r.bottom > 0 && r.top < window.innerHeight) { S.observer.disconnect(); S.revealed = true; el.dataset.reveal = 'done'; }
        else if (++checks < 600) check();
      }, checks ? 1000 : 2500);
    })();
  }

  /* ---------- drawing ---------- */
  function draw(ctx) {
    S.ctx = ctx;
    var key = ctx.dk(ctx.grid.start.getTime());
    if (S.key !== key || !N.box.querySelector('.heat')) build(ctx.grid, key);

    var vals = [], values = [], i;
    for (i = 0; i < CELLS; i++) {
      var fut = S.dates[i] > ctx.grid.today;
      var v = fut ? -1 : (ctx.sum4(ctx.agg.days[dateKey(S.dates[i])], ctx.incl) || 0);
      values.push(v);
      if (v > 0) vals.push(v);
      if (!fut) S.last = i;
    }
    vals.sort(function (a, b) { return a - b; });
    var q = function (p) { return vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0; };
    var t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
    var per = [0, 0, 0, 0, 0];

    /* A new source or cache setting recolors the grid as a sweep instead of snapping. */
    var sweep = S.sig !== null && S.sig !== ctx.sig && S.revealed && !REDUCED;
    if (sweep) {
      S.el.classList.add('wave');
      window.clearTimeout(S.waveTimer);
      S.waveTimer = window.setTimeout(function () { S.el.classList.remove('wave'); }, WAVE + 500);
    }
    S.sig = ctx.sig;

    for (i = 0; i < CELLS; i++) {
      var val = values[i], el = S.els[i];
      var l = val < 0 ? 'x' : val === 0 ? '0' : val <= t1 ? '1' : val <= t2 ? '2' : val <= t3 ? '3' : '4';
      if (l !== 'x') per[+l]++;
      if (el.dataset.l !== l) el.dataset.l = l;
      el._v = val;
      if (l === 'x') { el.removeAttribute('aria-label'); el.removeAttribute('aria-selected'); el.removeAttribute('tabindex'); }
      else {
        el.setAttribute('aria-label', (val > 0 ? ctx.fmt(val) + ' tokens' : 'No tokens') + ', ' + S.dates[i].toLocaleDateString(undefined, LONG));
        el.setAttribute('aria-selected', S.selected === dateKey(S.dates[i]) ? 'true' : 'false');
      }
    }
    S.perLevel = per;
    S.ranges = ['no tokens', 'up to ' + ctx.fmt(t1), ctx.fmt(t1) + ' to ' + ctx.fmt(t2), ctx.fmt(t2) + ' to ' + ctx.fmt(t3), ctx.fmt(t3) + ' or more'];
    if (S.focus < 0 || S.focus > S.last) setFocusable(S.last);
    buildLegend(t1, t2, t3);
    applyHighlight();
    placeRing();
    renderInfo();
    if (S.tipOpen && S.tipCell) fillTip(S.tipCell, false);
  }

  function setFocusable(i) {
    if (S.focus >= 0 && S.els[S.focus]) S.els[S.focus].tabIndex = -1;
    S.focus = i;
    if (S.els[i]) S.els[i].tabIndex = 0;
  }

  /* ---------- legend ---------- */
  function buildLegend(t1, t2, t3) {
    var sig = t1 + ':' + t2 + ':' + t3;
    if (S.legendSig !== sig || !N.legend.querySelector('.swb')) {
      S.legendSig = sig;
      var sw = '';
      for (var lv = 0; lv < 5; lv++) {
        sw += '<button type="button" class="swb" data-lv="' + lv + '" style="background:var(--h' + lv + ')" tabindex="' + (lv === 0 ? 0 : -1) + '" aria-pressed="false" aria-label="Highlight days with ' + S.ranges[lv] + '"></button>';
      }
      N.legend.innerHTML = '<span class="cap" id="cap" aria-live="polite"></span><span class="scale"><span aria-hidden="true">Less</span><span class="sws" role="group" aria-label="Highlight days by level">' + sw + '</span><span aria-hidden="true">More</span></span>';
    } else {
      N.legend.querySelectorAll('.swb').forEach(function (b, lv) { b.setAttribute('aria-label', 'Highlight days with ' + S.ranges[lv]); });
    }
  }
  function setPreview(lv) {
    window.clearTimeout(S.previewTimer);
    if (lv !== null) { S.preview = lv; applyHighlight(); }
    else S.previewTimer = window.setTimeout(function () { S.preview = null; applyHighlight(); }, 90);
  }
  function applyHighlight() {
    var hl = S.preview !== null ? S.preview : S.pinned;
    if (!S.el) return;
    if (hl === null) S.el.removeAttribute('data-hl'); else S.el.dataset.hl = hl;
    N.legend.querySelectorAll('.swb').forEach(function (b) { b.setAttribute('aria-pressed', S.pinned === +b.dataset.lv ? 'true' : 'false'); });
    var cap = N.legend.querySelector('#cap');
    if (cap) cap.textContent = hl === null ? '' : S.perLevel[hl] + (S.perLevel[hl] === 1 ? ' day' : ' days') + ' with ' + S.ranges[hl];
  }

  /* ---------- selection ---------- */
  function select(i) {
    var key = dateKey(S.dates[i]);
    S.selected = S.selected === key ? null : key;
    S.els.forEach(function (el, n) {
      if (el.dataset.l !== 'x') el.setAttribute('aria-selected', dateKey(S.dates[n]) === S.selected ? 'true' : 'false');
    });
    placeRing();
    renderInfo();
  }
  function placeRing() {
    var ring = S.el && S.el.querySelector('.ring');
    if (!ring) return;
    var i = S.selected !== null ? S.index[S.selected] : undefined;
    var cell = i !== undefined ? S.els[i] : null;
    if (!cell || cell.dataset.l === 'x') { ring.classList.remove('on'); return; }
    ring.style.left = cell.offsetLeft - 2 + 'px';
    ring.style.top = cell.offsetTop - 2 + 'px';
    ring.style.width = cell.offsetWidth + 4 + 'px';
    ring.style.height = cell.offsetHeight + 4 + 'px';
    ring.classList.add('on');
  }
  function renderInfo() {
    var info = N.info, ctx = S.ctx;
    var i = S.selected !== null ? S.index[S.selected] : undefined;
    if (i === undefined || !ctx || S.els[i].dataset.l === 'x') { info.hidden = true; return; }
    var a = ctx.agg.days[S.selected] || [0, 0, 0, 0], total = ctx.sum4(a, ctx.incl);
    var html = '<b>' + S.dates[i].toLocaleDateString(undefined, SHORT) + '</b><span>' + ctx.fmt(total) + ' tokens</span>';
    if (total > 0) {
      html += '<span>Input ' + ctx.fmt(a[0]) + '</span><span>Output ' + ctx.fmt(a[1]) + '</span>';
      if (!ctx.chatOnly && (a[2] || a[3])) html += '<span>Cache write ' + ctx.fmt(a[2]) + '</span><span>Cache read ' + ctx.fmt(a[3]) + '</span>';
    }
    info.innerHTML = html;
    info.hidden = false;
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    var c = cellOf(e.target);
    if (!c) return;
    var i = +c.dataset.i;
    var moves = { ArrowUp: i - 1, ArrowDown: i + 1, ArrowLeft: i - 7, ArrowRight: i + 7, Home: 0, End: S.last };
    if (e.key in moves) {
      e.preventDefault();
      var next = Math.min(Math.max(moves[e.key], 0), S.last);
      setFocusable(next);
      S.els[next].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(i);
    } else if (e.key === 'Escape' && S.tipOpen) {
      e.preventDefault();
      hideSoon(0);
    }
  }

  /* ---------- tooltip ---------- */
  function fillTip(cell, animate) {
    var v = cell._v, tip = N.tip;
    var l1 = tip.querySelector('.t1'), l2 = tip.querySelector('.t2');
    var text1 = v > 0 ? S.ctx.fmt(v) + ' tokens' : 'No tokens';
    var text2 = S.dates[+cell.dataset.i].toLocaleDateString(undefined, SHORT);
    var changed = l1.textContent !== text1 || l2.textContent !== text2;
    l1.textContent = text1; l2.textContent = text2;
    if (animate && changed && !REDUCED) {
      var dir = Math.sign(v - S.tipValue);
      [l1, l2].forEach(function (el) { el.style.setProperty('--dir', dir); el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); });
    }
    S.tipValue = v;
  }
  function place(cell, glide) {
    var tip = N.tip, bubble = tip.firstElementChild;
    var sec = tip.parentNode.getBoundingClientRect(), r = cell.getBoundingClientRect();
    var half = bubble.offsetWidth / 2;
    var x = Math.min(Math.max(r.left - sec.left + r.width / 2, half + 2), sec.width - half - 2);
    tip.classList.toggle('glide', glide && !REDUCED);
    tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(r.top - sec.top) + 'px)';
  }
  function showTip(cell) {
    window.clearTimeout(S.hideTimer);
    var tip = N.tip, wasOpen = S.tipOpen;
    fillTip(cell, wasOpen);
    S.tipCell = cell;
    if (!wasOpen) {
      tip.classList.remove('glide');
      place(cell, false);
      void tip.offsetWidth;
      tip.classList.add('open');
      S.tipOpen = true;
    } else {
      place(cell, true);
    }
  }
  function hideSoon(delay) {
    window.clearTimeout(S.hideTimer);
    S.hideTimer = window.setTimeout(function () { N.tip.classList.remove('open', 'glide'); S.tipOpen = false; S.tipCell = null; }, delay);
  }

  /* ---------- rolling total: only the digits that changed turn ---------- */
  function setTotal(el, text) {
    var prev = S.totalText || '', pc = prev.split(''), chars = text.split('');
    var dir = text.length !== prev.length ? (text.length > prev.length ? 1 : -1) : (text >= prev ? 1 : -1);
    var html = '';
    chars.forEach(function (ch, i) {
      var was = pc[pc.length - (chars.length - i)];
      var roll = prev && was !== ch && !REDUCED;
      html += '<span class="ch' + (roll ? ' roll' : '') + '" style="--dir:' + dir + '">' + ch + '</span>';
    });
    el.innerHTML = html;
    el.setAttribute('aria-label', text);
    S.totalText = text;
  }

  /* Leaving the daily view discards the grid; the tooltip and legend go with it. */
  function reset() {
    S.key = null; S.legendSig = null; S.el = null;
    if (S.observer) S.observer.disconnect();
    window.clearTimeout(S.hideTimer);
    window.clearTimeout(S.revealTimer);
    if (N.tip) { N.tip.classList.remove('open', 'glide'); S.tipOpen = false; S.tipCell = null; }
    if (N.info) N.info.hidden = true;
  }

  window.Heat = { init: init, draw: draw, reset: reset, setTotal: setTotal };
})();
