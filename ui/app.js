// tide — интерфейс десктоп-клиента.
'use strict';

// ===== Ссылки =====
const BOT = 'https://t.me/roam_vpn_buy_bot';
const SUPPORT = 'https://t.me/tidevpn_buy';
const CHANNEL = 'https://t.me/tide_vpn';

const S = window.TideSub;
const T = window.__TAURI__;
const $ = id => document.getElementById(id);

// ===== Связь с системной частью (в браузере без Tauri — заглушки для предпросмотра) =====
const invoke = (cmd, args) => T ? T.core.invoke(cmd, args) : Promise.reject('preview');
const openUrl = url => T ? T.opener.openUrl(url) : window.open(url, '_blank');

// ===== Хранилище =====
const store = {
  get(k, d) { try { const v = localStorage.getItem('tide.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tide.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('tide.' + k); } catch (e) {} },
};

const st = {
  url: store.get('url', ''),
  sub: store.get('sub', null),             // результат parseSubscription
  updated: store.get('updated', 0),
  selected: store.get('selected', 'auto'),
  mode: store.get('mode', 'proxy'),
  ruDirect: store.get('ruDirect', false),
  autoConnect: store.get('autoConnect', false),
  conn: 'off',                              // off | busy | on
  since: 0,
  pings: {},
  autoNow: '',
};

// ===== Мелочи =====
let toastT;
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = ''; }, err ? 6000 : 2400);
}
function bytes(n) {
  n = Number(n) || 0;
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
}
const pad = n => String(n).padStart(2, '0');
function plural(n, a, b, c) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ===== Навигация =====
let view = 'home';
function go(v) {
  view = v;
  ['welcome', 'home', 'servers', 'plans', 'help', 'settings'].forEach(x => { $('v-' + x).hidden = x !== v; });
  const w = v === 'welcome';
  document.body.classList.toggle('welcome', w);
  $('nav').hidden = w;
  $('brand').hidden = !w;
  document.querySelectorAll('#nav .navb').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('main').scrollTop = 0;
  if (v === 'servers' || v === 'home') renderServers();
  if (v === 'settings') renderSettings();
}
document.querySelectorAll('#nav .navb').forEach(b => { b.onclick = () => go(b.dataset.v); });

// ===== Подписка =====
async function loadSub(url, quiet) {
  let resp;
  try {
    resp = await invoke('fetch_sub', { url });
  } catch (e) {
    if (!quiet) toast('Не удалось загрузить подписку: ' + e, true);
    return false;
  }
  if (resp.status >= 400) {
    if (!quiet) toast(`Сервер подписки ответил ошибкой ${resp.status}. Проверьте ссылку.`, true);
    return false;
  }
  const sub = S.parseSubscription(resp);
  if (!sub.servers.length) {
    if (!quiet) toast('В подписке нет серверов, которые поддерживает tide.', true);
    return false;
  }
  st.sub = sub;
  st.updated = Date.now();
  store.set('sub', sub);
  store.set('updated', st.updated);
  if (st.selected !== 'auto' && !sub.servers.some(s => s.tag === st.selected)) {
    st.selected = 'auto';
    store.set('selected', 'auto');
  }
  renderHome();
  return true;
}

function setUrl(url) {
  st.url = url.trim();
  store.set('url', st.url);
}

$('w-go').onclick = async () => {
  const url = $('w-url').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Ссылка должна начинаться с https://', true);
  $('w-go').disabled = true;
  $('w-go').textContent = 'Загружаю…';
  const ok = await loadSub(url);
  $('w-go').disabled = false;
  $('w-go').textContent = 'Продолжить';
  if (ok) { setUrl(url); go('home'); toast(`Готово: ${st.sub.servers.length} ${plural(st.sub.servers.length, 'сервер', 'сервера', 'серверов')}`); }
};
$('w-url').onkeydown = e => { if (e.key === 'Enter') $('w-go').click(); };
$('w-buy').onclick = () => openUrl(BOT);

// ===== Подключение =====
function config() {
  return S.buildConfig(st.sub.servers, { mode: st.mode, selected: st.selected, ruDirect: st.ruDirect });
}

async function connect() {
  if (!st.sub || !st.sub.servers.length) return toast('Сначала добавьте подписку', true);
  setConn('busy');
  try {
    await invoke('connect', { config: JSON.stringify(config()), tun: st.mode === 'tun' });
    st.since = Date.now();
    setConn('on');
    setTimeout(refreshAutoNow, 2500);
    setTimeout(() => $('ping-all').click(), 3000);   // сразу измерить пинг
  } catch (e) {
    setConn('off');
    if (String(e) !== 'Отменено') toast('Не удалось подключиться.\n' + e, true);
  }
}
async function disconnect() {
  setConn('busy');
  try { await invoke('disconnect'); } catch (e) {}
  setConn('off');
}
function toggle() {
  if (st.conn === 'busy') return;
  st.conn === 'on' ? disconnect() : connect();
}
async function reconnect() {
  if (st.conn !== 'on') return;
  await connect();
}
$('power').onclick = toggle;

function setConn(c) {
  st.conn = c;
  const p = $('power');
  p.className = 'power ' + c;
  $('state').textContent = c === 'on' ? 'ЗАЩИЩЕНО' : c === 'busy' ? 'ПОДКЛЮЧЕНИЕ…' : 'ОТКЛЮЧЕНО';
  $('state').className = 'state' + (c === 'on' ? ' on' : '');
  p.title = c === 'on' ? 'Отключить' : 'Подключить';
  $('live').className = 'live' + (c === 'on' ? ' on' : '');
  if (c !== 'on') { $('timer').textContent = '00:00:00'; $('traffic').textContent = '↓ 0 Б · ↑ 0 Б'; st.autoNow = ''; }
  renderCurrent();
}

// таймер, трафик, проверка что ядро живо
setInterval(async () => {
  if (st.conn === 'on') {
    const s = Math.floor((Date.now() - st.since) / 1000);
    $('timer').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }
}, 1000);

setInterval(async () => {
  if (!T || st.conn === 'busy') return;
  let s;
  try { s = await invoke('status'); } catch (e) { return; }
  if (st.conn === 'on' && !s.running) {
    setConn('off');
    toast('VPN отключился. Подробности в журнале (Настройки).', true);
  } else if (st.conn === 'off' && s.running) {
    st.since = Date.now();
    setConn('on');
  }
  if (st.conn === 'on') {
    try {
      const c = JSON.parse(await invoke('clash', { method: 'GET', path: '/connections' }));
      $('traffic').textContent = `↓ ${bytes(c.downloadTotal)} · ↑ ${bytes(c.uploadTotal)}`;
    } catch (e) {}
  }
}, 2000);

async function refreshAutoNow() {
  if (st.conn !== 'on' || st.selected !== 'auto') return;
  try {
    const a = JSON.parse(await invoke('clash', { method: 'GET', path: '/proxies/auto' }));
    st.autoNow = a.now || '';
    renderCurrent();
  } catch (e) {}
}
setInterval(refreshAutoNow, 30000);

// ===== Главная =====
function renderCurrent() {
  renderServers();
}

function renderMode() {
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.m === st.mode));
  $('mode-hint').textContent = st.mode === 'tun'
    ? (isMac() ? 'Через VPN идёт всё. При подключении macOS попросит пароль.' : 'Через VPN идёт всё. Нужен запуск от имени администратора.')
    : 'Браузер, Telegram и большинство программ. Пароль не нужен.';
}
document.querySelectorAll('#mode button').forEach(b => {
  b.onclick = () => {
    if (st.mode === b.dataset.m) return;
    st.mode = b.dataset.m;
    store.set('mode', st.mode);
    renderMode();
    reconnect();
  };
});

function renderHome() {
  renderCurrent();
  renderMode();
  const sub = st.sub;
  if (!sub) return;
  let daysTxt = 'Бессрочно', until = '', width = '100%', color = '';
  if (sub.expire) {
    const ms = sub.expire * 1000 - Date.now();
    const days = Math.max(0, Math.ceil(ms / 86400000));
    daysTxt = ms <= 0 ? 'Закончилась' : `${days} ${plural(days, 'день', 'дня', 'дней')}`;
    color = ms <= 0 ? 'var(--bad)' : days <= 3 ? 'var(--warn)' : '';
    until = 'до ' + new Date(sub.expire * 1000).toLocaleDateString('ru-RU');
    width = Math.min(100, days / 30 * 100) + '%';
  }
  // бессрочный ключ: продлевать нечего, кнопки «Продлить» прячем
  $('renew').hidden = $('mini-renew').hidden = !sub.expire;
  ['sub', 'mini'].forEach(p => {
    $(p + '-days').textContent = daysTxt;
    $(p + '-days').style.color = color;
    $(p + '-until').textContent = until;
    $(p + '-bar').style.width = width;
  });
  const used = (sub.upload || 0) + (sub.download || 0);
  $('sub-traffic').textContent = sub.total ? `${bytes(used)} из ${bytes(sub.total)}` : `трафик без ограничений`;
  syncSwitches();
}
$('renew').onclick = () => openUrl(BOT);
$('mini-renew').onclick = () => openUrl(BOT);

// ===== Серверы =====
function pingClass(p) { return !p ? '' : p < 150 ? 'g' : p < 400 ? 'y' : 'r'; }
function renderServers() {
  const servers = (st.sub && st.sub.servers) || [];
  const pingTxt = p => p === -1 ? 'нет ответа' : p ? p + ' мс' : '—';
  const autoSub = st.autoNow ? 'сейчас: ' + S.cleanName(st.autoNow) : 'самый быстрый за рубежом';
  // компактный список на экране «Подключение»
  const row = (tag, flag, name, sub, ping) => `
    <button class="item ${st.selected === tag ? 'on' : ''}" data-tag="${esc(tag)}">
      <span class="flag">${flag}</span>
      <span class="nm"><b>${esc(name)}</b><span>${esc(sub)}</span></span>
      <span class="ping ${pingClass(ping)}">${tag === 'auto' ? '' : pingTxt(ping)}</span>
      <span class="dot"></span>
    </button>`;
  $('home-list').innerHTML = '<div class="lh"><span class="cap">Сервер</span><button class="btn s" data-act="ping"' + (st.conn === 'on' ? '' : ' disabled') + '>Пинг</button></div>'
    + row('auto', st.autoNow ? S.flagOf(st.autoNow) : '⚡', 'Авто', autoSub, 0)
    + servers.map(s => row(s.tag, S.flagOf(s.tag), S.cleanName(s.tag), S.isRussian(s.tag) ? 'для российских сайтов' : 'за рубежом', st.pings[s.tag])).join('');
  // таблица на экране «Серверы»
  const trow = s => `
    <button class="item ${st.selected === s.tag ? 'on' : ''}" data-tag="${esc(s.tag)}">
      <span class="flag">${S.flagOf(s.tag)}</span>
      <span class="nm"><b>${esc(S.cleanName(s.tag))}</b></span>
      <span class="proto">${esc(s.type.toUpperCase())}</span>
      <span class="host">${esc(s.host)}</span>
      <span class="ping ${pingClass(st.pings[s.tag])}">${pingTxt(st.pings[s.tag])}</span>
      <span class="dot"></span>
    </button>`;
  const foreign = servers.filter(s => !S.isRussian(s.tag));
  const ru = servers.filter(s => S.isRussian(s.tag));
  $('srv-list').innerHTML = '<div class="th"><span></span><span>Сервер</span><span>Протокол</span><span class="hh">Адрес</span><span style="text-align:right">Пинг</span><span></span></div>'
    + `<button class="item ${st.selected === 'auto' ? 'on' : ''}" data-tag="auto"><span class="flag">⚡</span><span class="nm"><b>Авто</b></span><span class="proto">ЛУЧШИЙ</span><span class="host">${esc(autoSub)}</span><span class="ping"></span><span class="dot"></span></button>`
    + (foreign.length ? '<div class="grp">За рубежом</div>' + foreign.map(trow).join('') : '')
    + (ru.length ? '<div class="grp">Россия</div>' + ru.map(trow).join('') : '');
  $('ping-note').hidden = st.conn === 'on';
  renderFacts();
  $('ping-all').disabled = st.conn !== 'on';
  const sk = (st.sub && st.sub.skipped) || [];
  $('skipped').hidden = !sk.length;
  $('skipped').textContent = sk.length ? 'Не поддерживаются этим приложением: ' + sk.join(', ') : '';
}
async function pickServer(e) {
  if (e.target.closest('[data-act="ping"]')) return $('ping-all').click();
  const it = e.target.closest('.item');
  if (!it) return;
  st.selected = it.dataset.tag;
  store.set('selected', st.selected);
  renderServers();
  if (st.conn === 'on') {
    try {
      await invoke('clash', { method: 'PUT', path: '/proxies/proxy', body: JSON.stringify({ name: st.selected }) });
      toast('Сервер переключён');
      setTimeout(refreshAutoNow, 1500);
    } catch (e) { toast('Не удалось переключить: ' + e, true); }
  }
}
$('srv-list').onclick = pickServer;
const PROTO = { hysteria2: 'Hysteria2', vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', tuic: 'TUIC' };
function renderFacts() {
  const tag = st.selected === 'auto' ? st.autoNow : st.selected;
  const srv = tag && st.sub ? st.sub.servers.find(s => s.tag === tag) : null;
  $('f-srv').textContent = srv ? S.flagOf(tag) + ' ' + S.cleanName(tag) : st.selected === 'auto' ? '⚡ Авто' : '—';
  $('f-proto').textContent = srv ? (PROTO[srv.type] || srv.type) : '—';
  const p = srv && st.conn === 'on' ? st.pings[tag] : 0;
  $('f-ping').textContent = p === -1 ? 'нет ответа' : p ? p + ' мс' : '—';
  $('f-ping').className = pingClass(p > 0 ? p : 0);
}
$('home-list').onclick = pickServer;
$('ping-all').onclick = async () => {
  if (st.conn !== 'on' || !st.sub) return;
  $('ping-all').disabled = true;
  await Promise.all(st.sub.servers.map(async s => {
    try {
      const r = JSON.parse(await invoke('clash', { method: 'GET',
        path: `/proxies/${encodeURIComponent(s.tag)}/delay?timeout=4000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}` }));
      st.pings[s.tag] = r.delay || -1;
    } catch (e) { st.pings[s.tag] = -1; }
    renderServers();
  }));
  $('ping-all').disabled = false;
  renderCurrent();
};

// ===== Тарифы и помощь =====
document.querySelectorAll('.plan').forEach(b => { b.onclick = () => openUrl(BOT); });
$('pay-other').onclick = () => openUrl(SUPPORT);
$('support').onclick = () => openUrl(SUPPORT);
$('channel').onclick = () => openUrl((st.sub && st.sub.support) || CHANNEL);

// ===== Настройки =====
function syncSwitches() {
  document.querySelectorAll('.sw').forEach(s => s.classList.toggle('on', !!st[s.dataset.k]));
}
function renderSettings() {
  $('s-url').value = st.url;
  syncSwitches();
  $('s-updated').textContent = st.updated ? 'Обновлено ' + new Date(st.updated).toLocaleString('ru-RU') : '';
}
document.querySelectorAll('.sw').forEach(s => {
  s.onclick = () => {
    const k = s.dataset.k;
    st[k] = !st[k];
    store.set(k, st[k]);
    syncSwitches();
    if (k === 'ruDirect') { toast(st.ruDirect ? 'Российские сайты пойдут напрямую' : 'Весь трафик снова через VPN'); reconnect(); }
  };
});
$('s-save').onclick = async () => {
  const url = $('s-url').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Ссылка должна начинаться с https://', true);
  if (await loadSub(url)) { setUrl(url); renderSettings(); toast('Подписка сохранена'); reconnect(); }
};
$('q-refresh').onclick = () => $('s-refresh').click();
$('q-support').onclick = () => openUrl(SUPPORT);
$('s-refresh').onclick = async () => {
  if (await loadSub(st.url)) { renderSettings(); toast(`Обновлено: ${st.sub.servers.length} ${plural(st.sub.servers.length, 'сервер', 'сервера', 'серверов')}`); }
};
$('s-log').onclick = async () => {
  const l = $('log');
  if (!l.hidden) { l.hidden = true; return; }
  try { l.textContent = (await invoke('core_log')).trim() || 'Журнал пуст'; } catch (e) { l.textContent = String(e); }
  l.hidden = false;
};
$('s-reset').onclick = async () => {
  await disconnect();
  ['url', 'sub', 'updated', 'selected'].forEach(store.del);
  st.url = ''; st.sub = null; st.selected = 'auto';
  $('w-url').value = '';
  go('welcome');
};

// ===== Запуск =====
let platform = '';
const isMac = () => platform === 'macos';

(async function init() {
  try { platform = await invoke('platform'); } catch (e) {}
  if (isMac()) document.body.classList.add('mac');
  renderMode();
  if (T) T.event.listen('tray-toggle', toggle);
  setConn('off');
  if (!st.url || !st.sub) { go('welcome'); return; }
  go('home');
  renderHome();
  try {
    const s = await invoke('status');
    if (s.running) { st.since = Date.now(); setConn('on'); }
  } catch (e) {}
  const stale = Date.now() - st.updated > (st.sub.updateHours || 12) * 3600000;
  if (stale) await loadSub(st.url, true);
  setInterval(() => loadSub(st.url, true), (st.sub.updateHours || 12) * 3600000);
  if (st.autoConnect && st.conn === 'off') connect();
})();
