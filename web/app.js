/* Comic 8muses — giao diện đọc truyện tranh, chạy trong WebView.
 *
 * HTML của nguồn được Java tải hộ (/api/page) vì trang nguồn không trả CORS.
 * Ảnh đi qua /img để app tự lưu vào bộ nhớ đệm, nhờ vậy đọc lại không tốn mạng
 * và nút "Tải cả bộ" chỉ cần gọi /api/save cho từng trang.
 */
(function () {
  'use strict';

  var SITE = 'comics.8muses.com';
  var BUILD = '1.1.0';
  var LS = 'cm:';
  var SORTS = [['date', 'Mới'], ['like', 'Thích'], ['az', 'A-Z'], ['view', 'Xem']];

  var S = {
    route: 'home',       // home | browse | album | error
    path: '',
    album: null,
    pages: [],
    cur: 0,
    seq: 0,
    downloading: false,
    cancel: false,
    retryFn: null,
    confirmFn: null,
    lastY: 0,
    saveTimer: 0,
    chapters: null,
    chapterSeq: 0
  };

  var docCache = {};          // path -> { at, doc }
  var scrollMem = {};         // path -> y
  var toastTimer = 0;

  /* ----------------------------- tiện ích ----------------------------- */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtMB(n) {
    if (!n || n < 1024) return '0 KB';
    var kb = n / 1024;
    if (kb < 1024) return Math.round(kb) + ' KB';
    var mb = kb / 1024;
    var s = mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
    if (s.slice(-2) === '.0') s = s.slice(0, -2);
    return s + ' MB';
  }

  function pretty(s) {
    var t = s;
    try { t = decodeURIComponent(t); } catch (e) { /* giữ nguyên */ }
    return t.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function lsGet(k, d) {
    try {
      var v = localStorage.getItem(LS + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* đầy bộ nhớ */ }
  }
  function lsDel(k) {
    try { localStorage.removeItem(LS + k); } catch (e) { /* thôi */ }
  }

  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619);
    }
    h = h >>> 0;
    var out = h.toString(36);
    return out.length >= 4 ? out : ('0000' + out).slice(-4);
  }

  var appEl = $('app');
  var gateEl = $('gate');
  var mainEl = $('main');
  var topbar = $('topbar');
  var titleEl = $('title');
  var subEl = $('sub');
  var backBtn = $('back');
  var cacheBtn = $('cachebtn');
  var readerbar = $('readerbar');
  var barfill = $('barfill');
  var pgnow = $('pgnow');
  var pgtotal = $('pgtotal');
  var dlbtn = $('dlbtn');
  var sheetEl = $('sheet');
  var sheetTitle = $('sheet-title');
  var sheetBody = $('sheet-body');
  var toastEl = $('toast');

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 2600);
  }

  function showSheet(title, html) {
    sheetTitle.textContent = title;
    sheetBody.innerHTML = html;
    sheetEl.hidden = false;
    sheetBody.scrollTop = 0;
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    sheetEl.hidden = true;
    sheetBody.innerHTML = '';
    S.confirmFn = null;
    document.body.classList.remove('sheet-open');
  }

  function setTop(title, sub, canBack) {
    titleEl.textContent = title || '8muses';
    subEl.textContent = sub || '';
    backBtn.style.visibility = canBack ? 'visible' : 'hidden';
  }

  function showReaderBar(on) {
    readerbar.hidden = !on;
    readerbar.classList.remove('hide');
    if (!on) {
      dlbtn.classList.remove('busy');
      dlbtn.textContent = 'Tải cả bộ';
    }
  }

  function setBarsHidden(hidden) {
    topbar.classList.toggle('hide', hidden);
    readerbar.classList.toggle('hide', hidden);
  }

  function skeletonGrid(n) {
    var h = '<div class="skgrid">';
    for (var i = 0; i < (n || 6); i++) h += '<div class="skcard"></div>';
    return h + '</div>';
  }

  /* ----------------------------- cổng 18+ ----------------------------- */

  function adultOk() {
    try { return localStorage.getItem(LS + 'age') === '1'; } catch (e) { return false; }
  }

  function startApp() {
    gateEl.hidden = true;
    appEl.hidden = false;
    route();
  }

  function refuseAge() {
    gateEl.innerHTML = '<div class="gate-box">'
      + '<div class="gate-mark">18<span>+</span></div>'
      + '<h1>Không thể tiếp tục</h1>'
      + '<p class="gate-lead">App chỉ dành cho người từ 18 tuổi trở lên.</p>'
      + '<p class="gate-small">Bạn có thể đóng app. Nếu đã đủ tuổi, hãy mở lại và xác nhận.</p>'
      + '</div>';
  }

  /* ----------------------------- tải dữ liệu --------------------------- */

  function loadDoc(path, force) {
    var hit = docCache[path];
    if (hit && !force && Date.now() - hit.at < 5 * 60 * 1000) {
      return Promise.resolve(hit.doc);
    }
    return fetch('/api/page?u=' + enc(path), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function () {
          var e = new Error('HTTP ' + r.status);
          e.status = r.status;
          throw e;
        });
      }
      return r.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      docCache[path] = { at: Date.now(), doc: doc };
      trimDocs();
      return doc;
    }, function (err) {
      if (hit) return hit.doc;
      throw err;
    });
  }

  function trimDocs() {
    var keys = Object.keys(docCache);
    if (keys.length <= 8) return;
    keys.sort(function (a, b) { return (docCache[a].at || 0) - (docCache[b].at || 0); });
    while (keys.length > 8) delete docCache[keys.shift()];
  }

  function getCache() {
    return fetch('/api/cache', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ----------------------------- phân tích HTML ------------------------ */

  function parseTiles(doc) {
    var out = [];
    var nodes = doc.querySelectorAll('a.c-tile');
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      var img = a.querySelector('img');
      var href = a.getAttribute('href') || '';
      if (!img || !href || href.indexOf('/porn') !== 0) continue;
      var t = a.querySelector('.title-text');
      var title = (t ? t.textContent : '').trim() || a.getAttribute('title') || img.getAttribute('alt') || '';
      out.push({
        href: href,
        title: title,
        thumb: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || ''
      });
    }
    return out;
  }

  function parsePager(doc) {
    var res = { cur: 1, total: 1, links: {}, first: null, last: null };
    var nav = doc.querySelector('nav.pagination');
    if (!nav) return res;

    var c = nav.querySelector('.page.current');
    if (c) {
      var n0 = parseInt(c.textContent, 10);
      if (n0 > 0) res.cur = n0;
    }

    var as = nav.querySelectorAll('a');
    for (var i = 0; i < as.length; i++) {
      var a = as[i];
      var href = a.getAttribute('href') || '';
      var label = (a.getAttribute('aria-label') || '').toLowerCase();
      var txt = (a.textContent || '').trim();
      if (label.indexOf('first') >= 0) res.first = href;
      if (label.indexOf('last') >= 0) res.last = href;
      if (/^\d+$/.test(txt)) res.links[parseInt(txt, 10)] = href;
      var m = /(\d+)(?:\?.*)?$/.exec(href);
      if (m && label.indexOf('last') >= 0) res.links[parseInt(m[1], 10)] = href;
    }

    var max = res.cur;
    for (var k in res.links) if (+k > max) max = +k;
    if (res.last) {
      var lm = /(\d+)(?:\?.*)?$/.exec(res.last);
      if (lm) max = Math.max(max, +lm[1]);
    }
    res.total = max;
    return res;
  }

  function parseSorts(doc) {
    var map = {};
    var as = doc.querySelectorAll('a[href*="sort="]');
    for (var i = 0; i < as.length; i++) {
      var href = as[i].getAttribute('href') || '';
      var m = /[?&]sort=([a-z]+)/.exec(href);
      if (m && href.indexOf('/porn') === 0) map[m[1]] = href;
    }
    return map;
  }

  function crumbsHtml(path) {
    var p = path.split('?')[0];
    var parts = p.split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    var out = [{ label: 'Trang chủ', path: '/porn' }];
    var names = [];
    if (parts[0] === 'porn') {
      for (var i = 1; i < parts.length; i++) {
        if (parts[i] === 'album' || parts[i] === 'tag') continue;
        names.push(parts[i]);
        var acc = parts[i - 1] === 'tag'
          ? '/porn/tag/' + names.join('/')
          : '/porn/album/' + names.join('/');
        out.push({ label: pretty(parts[i]), path: acc });
      }
    }
    var html = '';
    for (var j = 0; j < out.length; j++) {
      if (j) html += '<span class="crumb-sep">›</span>';
      var cur = j === out.length - 1;
      html += '<a class="crumb' + (cur ? ' cur' : '') + '" data-path="' + esc(out[j].path) + '"'
        + ' href="#/b?u=' + esc(enc(out[j].path)) + '">' + esc(out[j].label) + '</a>';
    }
    return '<div class="crumbs">' + html + '</div>';
  }

  /* ----------------------------- điều hướng ---------------------------- */

  function go(href) {
    if (location.hash === href) route();
    else location.hash = href;
  }
  function goBrowse(path) { go('#/b?u=' + enc(path)); }
  function goAlbum(path, page) {
    go('#/r?u=' + enc(path) + (page > 0 ? '&p=' + page : ''));
  }

  function parseHash() {
    var raw = location.hash.replace(/^#/, '') || '/';
    var i = raw.indexOf('?');
    var path = i < 0 ? raw : raw.slice(0, i);
    var q = new URLSearchParams(i < 0 ? '' : raw.slice(i + 1));
    return { route: path, u: q.get('u') || '', p: parseInt(q.get('p') || '0', 10) || 0 };
  }

  function route() {
    closeSheet();
    var r = parseHash();
    if (r.route === '/r' && r.u) return openAlbumRoute(r.u, r.p);
    if (r.route === '/b' && r.u) return openBrowse(r.u);
    return openHome();
  }

  function openPath(path) {
    if (!path) return;
    if (path.indexOf('/porn/picture/') === 0) {
      var m = /^\/porn\/picture\/(.+)\/(\d+)$/.exec(path);
      if (m) { goAlbum('/porn/album/' + m[1], parseInt(m[2], 10)); return; }
    }
    if (path.indexOf('/porn') === 0) { goBrowse(path); return; }
  }

  /* ------------------------------- trang chủ --------------------------- */

  function openHome() {
    S.route = 'home';
    S.path = '/porn';
    S.album = null;
    S.pages = [];
    S.cur = 0;
    S.seq++;
    mainEl.className = 'main';
    topbar.classList.remove('hide');
    showReaderBar(false);
    stopObservers();
    setTop('8muses', 'Truyện tranh người lớn · 18+', false);
    mainEl.innerHTML = '<div class="intro"><h1>8<em>muses</em></h1>'
      + '<p>Truyện tranh người lớn · nguồn comics.8muses.com</p></div>' + skeletonGrid(8);

    var seq = S.seq;
    loadDoc('/porn').then(function (doc) {
      if (seq !== S.seq) return;
      renderHome(doc);
    }).catch(function (err) {
      if (seq !== S.seq) return;
      showError('Không tải được trang chủ',
        offlineText(err, 'Kiểm tra kết nối mạng rồi thử lại.'),
        function () { openHome(); });
    });
  }

  function renderHome(doc) {
    var tiles = parseTiles(doc);
    var pager = parsePager(doc);
    var last = lsGet('last', null);
    var html = '<div class="intro"><h1>8<em>muses</em></h1>'
      + '<p>Truyện tranh người lớn · nguồn comics.8muses.com</p></div>';

    if (last && last.path && last.title) {
      html += '<a class="hero" data-open="album" data-path="' + esc(last.path) + '"'
        + ' href="#/r?u=' + esc(enc(last.path)) + '">'
        + (last.cover ? '<img class="hero-cover" alt="" src="/img?u=' + esc(enc(last.cover)) + '">'
          : '<div class="hero-cover"></div>')
        + '<div class="hero-body"><div class="hero-label">Đọc tiếp</div>'
        + '<div class="hero-title">' + esc(last.title) + '</div>'
        + '<div class="hero-meta">Trang ' + (last.page || 1) + ' / ' + (last.n || '?') + '</div></div>'
        + '<div class="hero-go">▶</div></a>';
    }

    if (!navigator.onLine) {
      html += '<div class="offline-chip">● Không có mạng · đang dùng bản đã lưu</div>';
    }

    html += '<div class="section-head"><div class="section-title">Khám phá</div>'
      + '<div class="section-note">Trang ' + pager.cur + '/' + pager.total + '</div></div>';
    html += gridHtml(tiles);
    html += pagerHtml(pager);
    if (!tiles.length) html += '<p class="sheet-note">Trang này không có mục nào.</p>';

    mainEl.innerHTML = html;
    restoreScroll('/porn');
  }

  /* ------------------------------ trang duyệt -------------------------- */

  function openBrowse(path) {
    S.route = 'browse';
    S.path = path;
    S.album = null;
    S.pages = [];
    S.seq++;
    mainEl.className = 'main';
    topbar.classList.remove('hide');
    showReaderBar(false);
    setTop(pretty(path.split('?')[0].split('/').pop()), 'Đang tải…', true);
    mainEl.innerHTML = '<div class="skline w60"></div>' + skeletonGrid(8);

    var seq = S.seq;
    loadDoc(path).then(function (doc) {
      if (seq !== S.seq) return;
      var tiles = parseTiles(doc);
      if (tiles.length && tiles[0].href.indexOf('/porn/picture/') === 0) {
        renderAlbum(path, doc, 0, true);
        return;
      }
      renderBrowse(path, doc);
    }).catch(function (err) {
      if (seq !== S.seq) return;
      showError('Không mở được trang',
        offlineText(err, 'Trang này chưa được lưu trên máy. Hãy kết nối mạng rồi thử lại.'),
        function () { openBrowse(path); });
    });
  }

  function renderBrowse(path, doc) {
    S.route = 'browse';
    S.album = null;
    S.pages = [];
    S.cur = 0;
    stopObservers();
    showReaderBar(false);

    var tiles = parseTiles(doc);
    var pager = parsePager(doc);
    var sorts = parseSorts(doc);
    var h1 = doc.querySelector('h1.page-title') || doc.querySelector('h1');
    var name = h1 ? h1.textContent.trim() : pretty(path.split('?')[0].split('/').pop());

    var html = crumbsHtml(path);
    html += '<div class="page-head"><h1>' + esc(name) + '</h1>'
      + '<div class="meta">' + tiles.length + ' mục · trang ' + pager.cur + '/' + pager.total + '</div></div>';

    if (!navigator.onLine) {
      html += '<div class="offline-chip">● Không có mạng · đang dùng bản đã lưu</div>';
    }

    var sortHtml = '';
    var sm = /[?&]sort=([a-z]+)/.exec(path);
    var curSort = sm ? sm[1] : '';
    for (var i = 0; i < SORTS.length; i++) {
      var href = sorts[SORTS[i][0]];
      if (href) sortHtml += '<a class="sortchip' + (curSort === SORTS[i][0] ? ' on' : '') + '"'
        + ' data-path="' + esc(href) + '" href="#/b?u=' + esc(enc(href)) + '">'
        + esc(SORTS[i][1]) + '</a>';
    }
    if (sortHtml) html += '<div class="sorts">' + sortHtml + '</div>';

    html += gridHtml(tiles);
    html += pagerHtml(pager);
    if (!tiles.length) html += '<p class="sheet-note">Trang này không có mục nào.</p>';

    mainEl.innerHTML = html;
    setTop(name, tiles.length + ' mục · trang ' + pager.cur + '/' + pager.total, true);
    restoreScroll(path);
  }

  function gridHtml(tiles) {
    var last = lsGet('last', null);
    var h = '<div class="grid">';
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var read = last && last.path && (last.path === t.href || last.path.indexOf(t.href + '/') === 0);
      h += '<a class="card' + (read ? ' read' : '') + '" data-path="' + esc(t.href) + '"'
        + ' href="#/b?u=' + esc(enc(t.href)) + '">'
        + '<div class="cover">' + (t.thumb
          ? '<img loading="lazy" src="/img?u=' + esc(enc(t.thumb)) + '" alt="' + esc(t.title) + '">'
          : '') + '</div>'
        + '<div class="name">' + esc(t.title) + '</div></a>';
    }
    return h + '</div>';
  }

  function pagerHtml(pg) {
    if (!pg || pg.total <= 1) return '';
    var items = [];
    var cur = pg.cur;
    var total = pg.total;

    function hrefFor(n) {
      if (pg.links[n]) return pg.links[n];
      if (n === 1 && pg.first) return pg.first;
      if (n === total && pg.last) return pg.last;
      return null;
    }
    function btn(n, label, cls) {
      var href = hrefFor(n);
      if (!href) return '';
      return '<a class="pbtn ' + (cls || '') + '" data-path="' + esc(href) + '"'
        + ' href="#/b?u=' + esc(enc(href)) + '">' + label + '</a>';
    }

    items.push(btn(1, '«', cur === 1 ? 'off' : ''));
    if (cur > 1) items.push(btn(cur - 1, '‹', ''));
    else items.push('<span class="pbtn off">‹</span>');

    var shown = [];
    var start = Math.max(1, cur - 2);
    var end = Math.min(total, start + 4);
    start = Math.max(1, end - 4);
    if (start > 1) {
      shown.push(1);
      if (start > 2) shown.push(0);
    }
    for (var n = start; n <= end; n++) shown.push(n);
    if (end < total) {
      if (end < total - 1) shown.push(0);
      shown.push(total);
    }
    var seen = {};
    for (var j = 0; j < shown.length; j++) {
      var v = shown[j];
      if (!v) { items.push('<span class="pbtn dots">…</span>'); continue; }
      if (seen[v]) continue;
      seen[v] = 1;
      if (v === cur) items.push('<span class="pbtn on">' + v + '</span>');
      else {
        var href = hrefFor(v);
        if (href) items.push('<a class="pbtn" data-path="' + esc(href) + '"'
          + ' href="#/b?u=' + esc(enc(href)) + '">' + v + '</a>');
      }
    }

    if (cur < total) items.push(btn(cur + 1, '›', ''));
    else items.push('<span class="pbtn off">›</span>');
    items.push(btn(total, '»', cur === total ? 'off' : ''));

    var filtered = [];
    for (var k = 0; k < items.length; k++) if (items[k]) filtered.push(items[k]);
    return '<nav class="pager">' + filtered.join('') + '</nav>';
  }

  /* -------------------------------- đọc album -------------------------- */

  function openAlbumRoute(path, startPage) {
    S.route = 'album';
    S.path = path;
    S.seq++;
    S.album = null;
    S.pages = [];
    S.cur = 0;
    mainEl.className = 'main reading';
    topbar.classList.remove('hide');
    showReaderBar(false);
    setTop('Đang mở album…', '', true);
    mainEl.innerHTML = '<div class="pg"><div class="ph"><span class="ph-num">…</span></div></div>'
      + '<div class="pg"><div class="ph"><span class="ph-num">…</span></div></div>';

    var seq = S.seq;
    loadDoc(path).then(function (doc) {
      if (seq !== S.seq) return;
      var tiles = parseTiles(doc);
      if (!tiles.length || tiles[0].href.indexOf('/porn/picture/') !== 0) {
        try { history.replaceState(null, '', '#/b?u=' + enc(path)); } catch (e) { /* thôi */ }
        renderBrowse(path, doc);
        return;
      }
      renderAlbum(path, doc, startPage, true);
    }).catch(function (err) {
      if (seq !== S.seq) return;
      showError('Không mở được album',
        offlineText(err, 'Album này chưa được lưu trên máy. Hãy kết nối mạng để mở lần đầu.'),
        function () { openAlbumRoute(path, startPage); });
    });
  }

  function renderAlbum(path, doc, startPage, replaceRoute) {
    var h1 = doc.querySelector('h1.page-title') || doc.querySelector('h1');
    var title = h1 ? h1.textContent.trim() : pretty(path.split('/').pop());
    var tiles = parseTiles(doc).filter(function (t) {
      return t.href.indexOf('/porn/picture/') === 0 && t.thumb;
    });

    tiles.sort(function (a, b) { return pageNo(a.href) - pageNo(b.href); });
    var pages = [];
    for (var i = 0; i < tiles.length; i++) {
      pages.push({
        n: i + 1,
        thumb: tiles[i].thumb,
        fm: tiles[i].thumb.replace('/image/th/', '/image/fm/'),
        title: tiles[i].alt || ''
      });
    }
    if (!pages.length) {
      showError('Album trống', 'Trang này không có ảnh nào.', function () { openAlbumRoute(path, 0); });
      return;
    }

    var album = { id: hash(path), path: path, title: title, pages: pages };
    S.album = album;
    S.pages = pages;
    S.cur = 0;
    S.route = 'album';

    if (replaceRoute) {
      try { history.replaceState(null, '', '#/r?u=' + enc(path)); } catch (e) { /* thôi */ }
    }
    rememberAlbum(album);
    setTop(title, pages.length + ' trang', true);

    var html = '<div class="reader" id="reader">';
    for (var j = 0; j < pages.length; j++) {
      html += '<div class="pg" data-i="' + j + '">'
        + '<div class="ph"><span class="ph-num">' + (j + 1) + '</span></div>'
        + '<img data-src="/img?u=' + esc(enc(pages[j].fm)) + '&amp;k=fm/' + album.id + '/' + j + '"'
        + ' alt="Trang ' + (j + 1) + '" decoding="async"></div>';
    }
    html += '</div><div class="endcard"><div class="end-title">Hết album</div>'
      + '<div class="end-sub">' + pages.length + ' trang · ' + esc(title) + '</div>'
      + '<div class="end-actions">'
      + '<button class="btn ghost slim" data-act="first">Về đầu</button>'
      + '<button class="btn primary slim" data-act="home">Album khác</button>'
      + '</div></div>';
    mainEl.innerHTML = html;

    pgnow.textContent = '1';
    pgtotal.textContent = pages.length;
    barfill.style.width = (100 / pages.length) + '%';
    showReaderBar(true);
    topbar.classList.remove('hide');

    var pos = startPage > 0 ? { i: startPage - 1, off: 0 } : lsGet('pos:' + path, null);
    var valid = pos && typeof pos.i === 'number' && pos.i >= 0 && pos.i < pages.length;
    if (valid && pos.n && pos.n !== pages.length) valid = false;

    setupObservers(album);
    if (valid) {
      if (startPage <= 0 && pos.i > 0) toast('Đọc tiếp từ trang ' + (pos.i + 1) + ' / ' + pages.length);
      restorePos(album, pos);
    } else {
      window.scrollTo(0, 0);
      S.cur = 0;
      updateBar();
      loadAround(0);
      saveLast();
    }
  }

  function pageNo(href) {
    var m = /(\d+)\s*$/.exec(href);
    return m ? parseInt(m[1], 10) : 0;
  }

  function stopObservers() {
    if (S.loadIO) { S.loadIO.disconnect(); S.loadIO = null; }
    if (S.trackIO) { S.trackIO.disconnect(); S.trackIO = null; }
  }

  function setupObservers(album) {
    var reader = $('reader');
    if (!reader) return;
    var kids = reader.children;

    stopObservers();

    S.loadIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) loadPg(entries[i].target);
      }
    }, { rootMargin: '1600px 0px' });

    S.trackIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        var idx = parseInt(e.target.getAttribute('data-i'), 10);
        if (!isNaN(idx) && idx !== S.cur) {
          S.cur = idx;
          updateBar(album);
        }
      }
    }, { rootMargin: '-42% 0px -52% 0px', threshold: 0 });

    for (var j = 0; j < kids.length; j++) {
      S.loadIO.observe(kids[j]);
      S.trackIO.observe(kids[j]);
    }
  }

  function loadAround(i) {
    for (var j = Math.max(0, i - 1); j <= Math.min(S.pages.length - 1, i + 2); j++) loadPg(pgEl(j));
  }

  function pgEl(i) {
    var reader = $('reader');
    return reader ? reader.children[i] : null;
  }

  function loadPg(el) {
    if (!el) return;
    var img = el.querySelector('img');
    if (!img) return;
    var st = el.getAttribute('data-st');
    if (st === '1' || st === '2') return;
    el.setAttribute('data-st', '1');

    img.onload = function () {
      el.classList.add('loaded');
      el.classList.remove('err');
      el.setAttribute('data-st', '2');
      var retry = el.querySelector('.retry');
      if (retry) retry.parentNode.removeChild(retry);
      saveSoon();
    };
    img.onerror = function () {
      el.setAttribute('data-st', '0');
      el.classList.add('err');
      var ph = el.querySelector('.ph');
      if (ph && !ph.querySelector('.retry')) {
        var b = document.createElement('button');
        b.className = 'retry';
        b.setAttribute('data-act', 'retry-img');
        b.textContent = 'Thử lại';
        ph.appendChild(b);
      }
    };
    img.src = img.getAttribute('data-src');
  }

  function updateBar(album) {
    var a = album || S.album;
    if (!a) return;
    var i = Math.max(0, Math.min(S.cur, S.pages.length - 1));
    pgnow.textContent = String(i + 1);
    pgtotal.textContent = String(S.pages.length);
    barfill.style.width = (((i + 1) / S.pages.length) * 100) + '%';
    if (!S.downloading) {
      subEl.textContent = 'Trang ' + (i + 1) + ' / ' + S.pages.length;
    }
  }

  function restorePos(album, pos) {
    var i = Math.max(0, Math.min(pos.i, S.pages.length - 1));
    var off = Math.max(0, Math.min(1, pos.off || 0));
    loadAround(i);
    loadPg(pgEl(i));

    var cancelled = false;
    function cancel() { cancelled = true; }
    window.addEventListener('touchstart', cancel, { passive: true, once: true });
    window.addEventListener('wheel', cancel, { passive: true, once: true });
    window.addEventListener('keydown', cancel, { once: true });

    var times = [0, 120, 380, 800, 1500, 2400, 3600];
    times.forEach(function (ms) {
      setTimeout(function () {
        if (cancelled || S.route !== 'album' || S.album !== album) return;
        var el = pgEl(i);
        if (!el) return;
        var rect = el.getBoundingClientRect();
        window.scrollTo(0, window.pageYOffset + rect.top + off * rect.height);
        if (i !== S.cur) { S.cur = i; updateBar(album); }
        saveLast();
      }, ms);
    });
  }

  function saveSoon() {
    if (S.route !== 'album' || S.saveTimer) return;
    S.saveTimer = setTimeout(function () {
      S.saveTimer = 0;
      savePos();
    }, 650);
  }

  function savePos() {
    if (S.route !== 'album' || !S.album) return;
    var i = Math.max(0, Math.min(S.cur, S.pages.length - 1));
    var el = pgEl(i);
    if (!el) return;
    var rect = el.getBoundingClientRect();
    var h = rect.height || 1;
    var off = Math.max(0, Math.min(1, -rect.top / h));
    lsSet('pos:' + S.album.path, { i: i, off: off, n: S.pages.length, at: Date.now() });
    saveLast();
  }

  function saveLast() {
    var a = S.album;
    if (!a) return;
    var cover = a.pages[0] ? a.pages[0].thumb : '';
    lsSet('last', {
      path: a.path, id: a.id, title: a.title,
      page: Math.max(1, Math.min(S.cur + 1, a.pages.length)),
      n: a.pages.length, cover: cover, at: Date.now()
    });
  }

  function rememberAlbum(a) {
    var map = lsGet('albums', {}) || {};
    map[a.id] = {
      title: a.title, path: a.path, n: a.pages.length,
      at: Date.now(), cover: a.pages[0] ? a.pages[0].thumb : ''
    };
    var keys = Object.keys(map);
    if (keys.length > 120) {
      keys.sort(function (x, y) { return (map[x].at || 0) - (map[y].at || 0); });
      for (var i = 0; i < keys.length - 120; i++) delete map[keys[i]];
    }
    lsSet('albums', map);
  }

  /* ------------------------------ tải cả bộ ---------------------------- */

  function startDownload() {
    var a = S.album;
    if (!a) return;
    if (S.downloading) { openDownloadProgress(S.dlAlbum || a); return; }

    getCache().then(function (st) {
      var found = null;
      var albums = st.albums || [];
      for (var i = 0; i < albums.length; i++) if (albums[i].id === a.id) found = albums[i];
      var have = found ? found.files : 0;
      var bytes = found ? found.bytes : 0;
      var left = a.pages.length - have;
      if (left <= 0) { toast('Album này đã lưu đủ ' + a.pages.length + ' trang'); return; }

      var avg = have > 0 ? bytes / have : 150 * 1024;
      var est = left * avg;
      showSheet('Tải cả bộ', '<div class="stats">'
        + '<div class="stat"><b>' + a.pages.length + '</b><span>trang</span></div>'
        + '<div class="stat"><b>' + fmtMB(est) + '</b><span>còn phải tải</span></div>'
        + '<div class="stat"><b>' + have + '</b><span>đã lưu</span></div>'
        + '</div>'
        + '<p class="sheet-note" style="font-size:12.5px;color:#c3b7ab">Ảnh được lưu trên máy để đọc khi không có mạng. '
        + 'Dung lượng thực tế có thể khác; có thể xoá bất cứ lúc nào trong Bộ nhớ đệm.</p>'
        + '<button class="btn primary" data-act="dl-start">Bắt đầu tải</button>'
        + '<button class="btn ghost" data-act="close-sheet">Để sau</button>');
    }).catch(function () {
      showSheet('Tải cả bộ', '<p class="sheet-note">Không đọc được thông tin bộ nhớ đệm.</p>'
        + '<button class="btn primary" data-act="dl-start">Vẫn tải</button>'
        + '<button class="btn ghost" data-act="close-sheet">Để sau</button>');
    });
  }

  function openDownloadProgress(a) {
    showSheet('Đang tải', '<p class="sheet-note" style="font-size:13px;color:#c3b7ab">'
      + 'Đang tải album “' + esc(a.title) + '”. Giữ app mở để tải tiếp; có thể dừng bất cứ lúc nào.</p>'
      + '<button class="btn danger" data-act="dl-cancel">Dừng tải</button>'
      + '<button class="btn ghost" data-act="close-sheet">Thu nhỏ</button>');
  }

  function runDownload(a) {
    closeSheet();
    S.downloading = true;
    S.cancel = false;
    S.dlAlbum = a;

    var total = a.pages.length;
    var done = 0;
    var failed = 0;
    var bytes = 0;
    var idx = 0;

    dlbtn.classList.add('busy');
    dlbtn.textContent = '0/' + total;
    toast('Bắt đầu tải ' + total + ' trang');

    function paint() {
      if (S.downloading) dlbtn.textContent = done + '/' + total;
    }

    function work() {
      if (S.cancel || !S.downloading) return Promise.resolve();
      if (idx >= total) return Promise.resolve();
      var i = idx++;
      var url = '/api/save?u=' + enc(a.pages[i].fm) + '&k=fm/' + a.id + '/' + i;
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        done++;
        bytes += j.bytes || 0;
      }).catch(function () {
        failed++;
      }).then(function () {
        paint();
        return work();
      });
    }

    var workers = [];
    for (var w = 0; w < 3; w++) workers.push(work());

    Promise.all(workers).then(function () {
      var stopped = S.cancel;
      S.downloading = false;
      S.cancel = false;
      S.dlAlbum = null;
      dlbtn.classList.remove('busy');
      dlbtn.textContent = 'Tải cả bộ';
      if (stopped) {
        toast('Đã dừng · lưu ' + done + '/' + total + ' trang');
      } else if (done === 0 && failed > 0) {
        toast('Không tải được trang nào · kiểm tra kết nối');
      } else if (failed > 0) {
        toast('Đã lưu ' + done + '/' + total + ' trang · ' + failed + ' trang lỗi');
      } else {
        toast('Đã lưu ' + done + ' trang (' + fmtMB(bytes) + ')');
      }
      if (S.route === 'album' && S.album && S.album.id === a.id) updateBar();
    });
  }

  /* ----------------------------- bộ nhớ đệm ---------------------------- */

  function openCache() {
    showSheet('Bộ nhớ đệm', '<div class="skline"></div><div class="skline w60"></div>');
    getCache().then(function (st) {
      if (sheetEl.hidden) return;
      renderCache(st);
    }).catch(function () {
      if (sheetEl.hidden) return;
      showSheet('Bộ nhớ đệm', '<p class="sheet-note">Không đọc được thông tin bộ nhớ đệm.</p>'
        + '<button class="btn ghost" data-act="close-sheet">Đóng</button>');
    });
  }

  function renderCache(st) {
    var albums = (st.albums || []).slice();
    albums.sort(function (a, b) { return (b.bytes || 0) - (a.bytes || 0); });
    var known = lsGet('albums', {}) || {};

    var html = '<div class="stats">'
      + '<div class="stat"><b>' + fmtMB(st.total) + '</b><span>tổng dung lượng</span></div>'
      + '<div class="stat"><b>' + (st.images || 0) + '</b><span>ảnh đã lưu</span></div>'
      + '<div class="stat"><b>' + (st.pages || 0) + '</b><span>trang đã nhớ</span></div>'
      + '</div>';

    if (!albums.length) {
      html += '<p class="sheet-note">Chưa có album nào được tải. Khi bạn đọc, ảnh vẫn được lưu tự động; '
        + 'nút “Tải cả bộ” trong lúc đọc sẽ lưu toàn bộ album.</p>';
    } else {
      html += '<div class="section-title" style="margin:10px 0 2px">Album đã lưu</div>';
      for (var i = 0; i < albums.length; i++) {
        var a = albums[i];
        var k = known[a.id] || {};
        var title = k.title || ('Album ' + a.id);
        var open = k.path
          ? '<a class="sgrow" data-open="album" data-path="' + esc(k.path) + '" href="#/r?u=' + esc(enc(k.path)) + '">'
          : '<div class="sgrow">';
        var closeTag = k.path ? '</a>' : '</div>';
        html += '<div class="srow">' + open
          + '<div class="stitle">' + esc(title) + '</div>'
          + '<div class="ssub">' + a.files + ' ảnh · ' + fmtMB(a.bytes)
          + (k.n ? ' / ' + k.n + ' trang' : '') + '</div>' + closeTag
          + '<button class="sdel" data-act="del-album" data-id="' + esc(a.id) + '"'
          + ' data-title="' + esc(title) + '">Xoá</button></div>';
      }
    }

    html += '<p class="sheet-note">Trang HTML của album cũng được lưu để mở lại nhanh và đọc offline. '
      + 'Xoá ảnh không ảnh hưởng tới vị trí đang đọc.</p>';
    html += '<div class="sheet-actions"><button class="btn ghost slim" data-act="clear-cache">Xoá tất cả ảnh đã lưu</button></div>';
    html += '<p class="sheet-note" style="text-align:center;margin-top:18px">Comic 8muses ' + BUILD
      + ' · ' + SITE + '<br>Toàn bộ dữ liệu chỉ nằm trên máy này.</p>';
    sheetBody.innerHTML = html;
  }

  /* ------------------------------ bảng phụ ----------------------------- */

  function confirmSheet(title, text, label, danger, fn) {
    S.confirmFn = fn;
    showSheet(title, '<p class="sheet-note" style="font-size:13px;line-height:1.6;color:#c8bdb2">'
      + esc(text) + '</p>'
      + '<button class="btn ' + (danger ? 'danger' : 'primary') + '" data-act="confirm-yes">' + esc(label) + '</button>'
      + '<button class="btn ghost" data-act="close-sheet">Huỷ</button>');
  }

  function openJump() {
    if (!S.pages.length) return;
    var n = S.pages.length;
    var here = S.cur + 1;
    var marks = [];
    [1, Math.max(1, here - 25), Math.max(1, here - 5), here, Math.min(n, here + 5), Math.min(n, here + 25), n]
      .forEach(function (v) { if (marks.indexOf(v) < 0) marks.push(v); });

    var html = '<div class="jumprow"><input id="jumpnum" type="number" min="1" max="' + n
      + '" inputmode="numeric" placeholder="Trang 1 – ' + n + '">'
      + '<button class="btn primary slim" data-act="jump-go">Đi</button></div><div class="jumpgrid">';
    for (var i = 0; i < marks.length; i++) {
      html += '<button class="pbtn' + (marks[i] === here ? ' on' : '') + '" data-act="jump-to"'
        + ' data-n="' + marks[i] + '">' + marks[i] + '</button>';
    }
    html += '</div>';
    showSheet('Chuyển trang', html);
  }

  function openMore() {
    var a = S.album;
    if (!a) return;
    showSheet('Album', '<div class="srow"><div class="sgrow"><div class="stitle">' + esc(a.title) + '</div>'
      + '<div class="ssub">' + a.pages.length + ' trang · ' + esc(a.path) + '</div></div></div>'
      + '<button class="btn ghost slim" data-act="chapters">Chọn chương khác</button>'
      + '<button class="btn ghost slim" data-act="first">Về trang đầu</button>'
      + '<button class="btn danger slim" data-act="del-current">Xoá ảnh đã lưu của album</button>'
      + '<button class="btn ghost slim" data-act="cache">Bộ nhớ đệm</button>');
  }

  /* --------------------------- chọn chương ---------------------------- */

  function normPath(p) {
    var s = String(p == null ? '' : p).split('?')[0].replace(/\/+$/, '');
    try { s = decodeURIComponent(s); } catch (e) { /* giữ nguyên */ }
    return s;
  }

  /** Album nằm ở /porn/album/<tác giả>/<bộ>/<album> → bộ là bỏ đoạn cuối. */
  function seriesPathOf(path) {
    var p = String(path == null ? '' : path).split('?')[0].replace(/\/+$/, '');
    var parts = p.split('/').filter(Boolean);
    if (parts.length < 5 || parts[0] !== 'porn' || parts[1] !== 'album') return '';
    return '/porn/album/' + parts.slice(2, -1).join('/');
  }

  function openChapters() {
    var a = S.album;
    if (!a) return;
    if (S.route === 'album') savePos();
    var parent = seriesPathOf(a.path);
    if (!parent) {
      showSheet('Chọn chương', '<p class="chap-empty">Album này không nằm trong một bộ có nhiều chương.</p>'
        + '<button class="btn ghost" data-act="close-sheet">Đóng</button>');
      return;
    }

    var st = {
      parent: parent,
      list: [],
      seen: {},
      pager: null,
      loadedPage: 0,
      totalPages: 1,
      loading: false,
      seq: ++S.chapterSeq
    };
    S.chapters = st;
    showSheet('Chọn chương', '<p class="chap-lead">Đang tải danh sách chương…</p>'
      + '<div class="skline"></div><div class="skline w60"></div>');
    loadChapterPage(st, parent, 1);
  }

  function loadChapterPage(st, path, page) {
    if (!st || st.loading || S.chapters !== st) return;
    st.loading = true;
    if (st.loadedPage > 0) renderChapters(st, true);

    loadDoc(path).then(function (doc) {
      if (S.chapters !== st) return;
      var tiles = parseTiles(doc);
      for (var i = 0; i < tiles.length; i++) {
        var href = tiles[i].href;
        if (href.indexOf('/porn/album/') !== 0) continue;
        var key = normPath(href);
        if (st.seen[key]) continue;
        st.seen[key] = 1;
        st.list.push({ href: href, title: tiles[i].title, thumb: tiles[i].thumb });
      }

      var pg = parsePager(doc);
      st.pager = pg;
      st.loadedPage = page;
      st.totalPages = Math.max(page, pg.total || 1);
      st.loading = false;
      renderChapters(st, false);
    }).catch(function () {
      if (S.chapters !== st) return;
      st.loading = false;
      if (st.loadedPage === 0) {
        showSheet('Chọn chương', '<p class="chap-empty">Không tải được danh sách chương. '
          + (navigator.onLine ? 'Kiểm tra kết nối rồi thử lại.' : 'Bộ này chưa được lưu để đọc offline.')
          + '</p>'
          + '<button class="btn primary" data-act="chapters">Thử lại</button>'
          + '<button class="btn ghost" data-act="close-sheet">Đóng</button>');
      } else {
        renderChapters(st, false);
        toast('Không tải thêm được chương');
      }
    });
  }

  function renderChapters(st, keepScroll) {
    var a = S.album;
    if (!a || S.chapters !== st || sheetEl.hidden) return;

    var cur = normPath(a.path);
    var list = st.list.slice();
    var hasCur = false;
    for (var i = 0; i < list.length; i++) {
      if (normPath(list[i].href) === cur) { hasCur = true; break; }
    }
    if (!hasCur) {
      list.unshift({
        href: a.path,
        title: a.title,
        thumb: a.pages[0] ? a.pages[0].thumb : ''
      });
    }

    var seriesName = pretty(st.parent.split('/').pop());
    var more = st.loadedPage > 0 && st.loadedPage < st.totalPages;
    var lead = '<b>' + esc(seriesName) + '</b> · ';
    if (!st.list.length) lead += 'chưa có chương khác';
    else lead += st.list.length + ' chương' + (more ? ' đã tải' : '');

    var html = '<p class="chap-lead">' + lead + '</p><div class="chap-list">';
    for (var j = 0; j < list.length; j++) {
      var it = list[j];
      var isCur = normPath(it.href) === cur;
      var num = hasCur ? (j + 1) : (j === 0 ? 0 : j);
      var title = it.title || pretty(it.href.split('/').pop());
      var cover = it.thumb
        ? '<img class="chap-cover" loading="lazy" alt="" src="/img?u=' + esc(enc(it.thumb)) + '">'
        : '<span class="chap-cover"></span>';
      var no = '<span class="chap-no">' + (isCur ? '●' : num) + '</span>';
      var body = '<span class="chap-body"><span class="chap-title">' + esc(title) + '</span>'
        + '<span class="chap-sub">' + (isCur ? 'Đang đọc' : 'Chương ' + num) + '</span></span>';

      if (isCur) {
        html += '<div class="chap cur">' + no + cover + body + '</div>';
      } else {
        html += '<a class="chap" data-open="album" data-path="' + esc(it.href) + '"'
          + ' href="#/r?u=' + esc(enc(it.href)) + '">' + no + cover + body + '</a>';
      }
    }
    html += '</div>';

    if (more) {
      html += '<button class="btn ghost slim chap-more" data-act="chapters-more"'
        + (st.loading ? ' disabled' : '') + '>'
        + (st.loading ? 'Đang tải…' : 'Tải thêm chương') + '</button>';
    } else if (st.loadedPage > 1) {
      html += '<p class="chap-end">Đã tải hết chương.</p>';
    }
    html += '<p class="sheet-note" style="text-align:center;margin-top:14px">'
      + 'Vị trí đọc của từng chương được giữ riêng.</p>';

    var y = keepScroll ? sheetBody.scrollTop : 0;
    sheetBody.innerHTML = html;
    sheetBody.scrollTop = y;
  }

  function jumpTo(i) {
    if (!S.pages.length) return;
    i = Math.max(0, Math.min(i, S.pages.length - 1));
    var el = pgEl(i);
    if (!el) return;
    loadPg(el);
    var rect = el.getBoundingClientRect();
    window.scrollTo(0, window.pageYOffset + rect.top);
    S.cur = i;
    updateBar();
    savePos();
  }

  /* -------------------------------- lỗi -------------------------------- */

  function offlineText(err, hint) {
    if (!navigator.onLine) {
      return 'Không có kết nối mạng. Album đã lưu vẫn mở được; hãy kiểm tra mạng nếu đây là lần đầu.';
    }
    var m = err && err.message ? err.message : '';
    return hint + (m ? ' (' + m + ')' : '');
  }

  function showError(title, text, retry) {
    S.route = 'error';
    S.album = null;
    S.pages = [];
    S.seq++;
    S.retryFn = retry || null;
    readerbar.hidden = true;
    topbar.classList.remove('hide');
    mainEl.className = 'main';
    setTop('Không tải được', '', true);
    mainEl.innerHTML = '<div class="errbox"><div class="erricon">⚠</div>'
      + '<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>'
      + '<div class="err-actions">'
      + '<button class="btn primary slim" data-act="retry">Thử lại</button>'
      + '<button class="btn ghost slim" data-act="home">Trang chủ</button>'
      + '</div>'
      + '<p class="err-note">Bản ' + BUILD + ' · ' + SITE + '</p></div>';
  }

  /* ------------------------------ cuộn trang --------------------------- */

  function restoreScroll(path) {
    var y = scrollMem[path] ? scrollMem[path].y : 0;
    requestAnimationFrame(function () {
      window.scrollTo(0, y);
      setTimeout(function () {
        if (S.route !== 'album' && S.path === path) window.scrollTo(0, y);
      }, 120);
    });
  }

  window.addEventListener('scroll', function () {
    var y = window.pageYOffset || 0;

    if (S.route === 'album') {
      if (y > S.lastY + 10 && y > 90 && !S.downloading) setBarsHidden(true);
      else if (y < S.lastY - 8 || y < 20) setBarsHidden(false);
      saveSoon();
    } else if (S.route === 'home' || S.route === 'browse') {
      scrollMem[S.path] = { y: y };
    }

    S.lastY = y;
  }, { passive: true });

  window.addEventListener('pagehide', function () { savePos(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') savePos();
  });

  window.addEventListener('online', function () {
    toast('Đã có kết nối mạng');
  });
  window.addEventListener('offline', function () {
    toast('Mất kết nối · chuyển sang bản đã lưu');
  });

  /* ------------------------------ sự kiện ------------------------------ */

  document.addEventListener('click', function (e) {
    var el = e.target;

    if (S.route === 'album' && el.closest && el.closest('.pg') && !el.closest('[data-act]')) {
      var hidden = topbar.classList.contains('hide') || readerbar.classList.contains('hide');
      setBarsHidden(!hidden);
      return;
    }

    var pathEl = el.closest ? el.closest('[data-path]') : null;
    if (pathEl) {
      e.preventDefault();
      if (!sheetEl.hidden) closeSheet();
      var path = pathEl.getAttribute('data-path');
      if (pathEl.getAttribute('data-open') === 'album') goAlbum(path, 0);
      else openPath(path);
      return;
    }

    var actEl = el.closest ? el.closest('[data-act]') : null;
    if (!actEl) return;
    var act = actEl.getAttribute('data-act');

    if (act === 'close-sheet') { closeSheet(); return; }
    if (act === 'home') { go('#/'); return; }

    if (act === 'retry') {
      if (S.retryFn) S.retryFn();
      return;
    }

    if (act === 'retry-img') {
      var pg = actEl.closest('.pg');
      if (pg) {
        pg.classList.remove('err');
        pg.setAttribute('data-st', '0');
        loadPg(pg);
      }
      return;
    }

    if (act === 'first') { closeSheet(); jumpTo(0); return; }
    if (act === 'chapters') { openChapters(); return; }
    if (act === 'chapters-more') {
      var st = S.chapters;
      if (st && !st.loading && st.loadedPage > 0 && st.loadedPage < st.totalPages) {
        var next = st.loadedPage + 1;
        var href = st.pager && st.pager.links[next] ? st.pager.links[next] : st.parent + '/' + next;
        loadChapterPage(st, href, next);
      }
      return;
    }
    if (act === 'jump') { openJump(); return; }
    if (act === 'jump-go') {
      var input = $('jumpnum');
      var v = input ? parseInt(input.value, 10) : 0;
      if (v > 0) { closeSheet(); jumpTo(v - 1); }
      return;
    }
    if (act === 'jump-to') {
      var n = parseInt(actEl.getAttribute('data-n'), 10);
      if (n > 0) { closeSheet(); jumpTo(n - 1); }
      return;
    }

    if (act === 'download') { startDownload(); return; }
    if (act === 'dl-start') { if (S.album) runDownload(S.album); return; }
    if (act === 'dl-cancel') {
      S.cancel = true;
      closeSheet();
      toast('Đang dừng sau trang hiện tại…');
      return;
    }

    if (act === 'more') { openMore(); return; }
    if (act === 'cache') { closeSheet(); openCache(); return; }

    if (act === 'del-album') {
      var id = actEl.getAttribute('data-id');
      var t = actEl.getAttribute('data-title') || 'album này';
      confirmSheet('Xoá ảnh đã lưu', 'Xoá toàn bộ ảnh của “' + t + '” khỏi máy?', 'Xoá', true, function () {
        fetch('/api/delete?album=' + enc(id), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            toast('Đã xoá ' + fmtMB(j.freed || 0));
            openCache();
          })
          .catch(function () { toast('Không xoá được'); });
      });
      return;
    }

    if (act === 'del-current') {
      var a = S.album;
      if (!a) return;
      closeSheet();
      confirmSheet('Xoá ảnh đã lưu', 'Xoá toàn bộ ảnh của “' + a.title + '” khỏi máy? Bạn vẫn đọc online được.',
        'Xoá', true, function () {
          fetch('/api/delete?album=' + enc(a.id), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) { toast('Đã xoá ' + fmtMB(j.freed || 0)); })
            .catch(function () { toast('Không xoá được'); });
        });
      return;
    }

    if (act === 'clear-cache') {
      confirmSheet('Xoá tất cả', 'Xoá toàn bộ ảnh và trang HTML đã lưu trên máy? Vị trí đang đọc vẫn được giữ.',
        'Xoá tất cả', true, function () {
          fetch('/api/clear', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              toast('Đã xoá ' + fmtMB(j.freed || 0));
              openCache();
            })
            .catch(function () { toast('Không xoá được'); });
        });
      return;
    }

    if (act === 'confirm-yes') {
      var fn = S.confirmFn;
      S.confirmFn = null;
      closeSheet();
      if (fn) fn();
      return;
    }
  });

  backBtn.addEventListener('click', function () {
    if (history.length > 1) history.back();
    else go('#/');
  });

  cacheBtn.addEventListener('click', openCache);

  $('gate-yes').addEventListener('click', function () {
    try { localStorage.setItem(LS + 'age', '1'); } catch (e) { /* thôi */ }
    startApp();
  });
  $('gate-no').addEventListener('click', refuseAge);

  sheetEl.addEventListener('click', function (e) {
    if (e.target === sheetEl) closeSheet();
  });

  window.addEventListener('hashchange', route);

  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { /* thôi */ }

  if (adultOk()) startApp();
  else gateEl.hidden = false;

  /* Để kiểm thử tự động nhận ra bản đang chạy. */
  try {
    window.__CM__ = { build: BUILD, source: SITE, state: S };
  } catch (e) { /* thôi */ }
})();
