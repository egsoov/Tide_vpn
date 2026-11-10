// Подписка → список серверов → конфиг sing-box (формат 1.11).
// Работает и в приложении (window.TideSub), и в node для тестов (module.exports).
(function (root) {
  const PROXY_PORT = 17890;
  const CLASH_PORT = 17891;

  function b64decode(s) {
    s = String(s || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    try {
      const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function header(headers, name) {
    const k = Object.keys(headers || {}).find(h => h.toLowerCase() === name);
    return k ? headers[k] : '';
  }

  function maybeB64(v) {
    // 3x-ui присылает profile-title как "base64:...."
    if (v && v.startsWith('base64:')) return b64decode(v.slice(7)) || v;
    return v;
  }

  function parseUserinfo(v) {
    const out = {};
    String(v || '').split(';').forEach(p => {
      const [k, val] = p.split('=').map(x => (x || '').trim());
      if (k) out[k] = Number(val) || 0;
    });
    return out;
  }

  function dec(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function parseQuery(q) {
    const o = {};
    (q || '').split('&').forEach(p => {
      if (!p) return;
      const i = p.indexOf('=');
      const k = dec(i < 0 ? p : p.slice(0, i));
      o[k] = i < 0 ? '' : dec(p.slice(i + 1).replace(/\+/g, '%20'));
    });
    return o;
  }

  // scheme://userinfo@host:port/path?query#name
  function splitUri(uri) {
    const m = uri.match(/^([a-z0-9+]+):\/\/([^#]*)(?:#(.*))?$/i);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const name = dec(m[3] || '');
    let rest = m[2];
    let query = '';
    const qi = rest.indexOf('?');
    if (qi >= 0) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
    rest = rest.replace(/\/+$/, '');
    const at = rest.lastIndexOf('@');
    const user = at >= 0 ? dec(rest.slice(0, at)) : '';
    let hostport = at >= 0 ? rest.slice(at + 1) : rest;
    let host, port;
    const v6 = hostport.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) { host = v6[1]; port = v6[2]; } else {
      const ci = hostport.lastIndexOf(':');
      host = ci >= 0 ? hostport.slice(0, ci) : hostport;
      port = ci >= 0 ? hostport.slice(ci + 1) : '';
    }
    return { scheme, user, host, port: Number(port) || 443, q: parseQuery(query), name };
  }

  const truthy = v => v === '1' || v === 'true' || v === 'yes';
  const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

  function tlsFrom(q, host, force) {
    const sec = (q.security || '').toLowerCase();
    if (!force && sec !== 'tls' && sec !== 'reality' && sec !== 'xtls') return undefined;
    const tls = { enabled: true, server_name: q.sni || q.peer || q.host || host };
    if (truthy(q.allowInsecure) || truthy(q.insecure)) tls.insecure = true;
    if (q.alpn) tls.alpn = list(q.alpn);
    const fp = q.fp || (sec === 'reality' ? 'chrome' : '');
    if (fp) tls.utls = { enabled: true, fingerprint: fp };
    if (sec === 'reality') {
      tls.reality = { enabled: true, public_key: q.pbk || '', short_id: q.sid || '' };
    }
    return tls;
  }

  // Возвращает transport или null (если тип не поддерживается sing-box, например xhttp)
  function transportFrom(q) {
    const t = (q.type || q.net || 'tcp').toLowerCase();
    if (t === 'tcp' || t === 'raw' || t === '') {
      if ((q.headerType || '') === 'http') return { type: 'http', host: list(q.host), path: q.path || '/' };
      return undefined;
    }
    if (t === 'ws') {
      const tr = { type: 'ws', path: q.path || '/' };
      if (q.host) tr.headers = { Host: q.host };
      return tr;
    }
    if (t === 'grpc') return { type: 'grpc', service_name: q.serviceName || q.path || '' };
    if (t === 'httpupgrade') return { type: 'httpupgrade', path: q.path || '/', host: q.host || '' };
    if (t === 'http' || t === 'h2') return { type: 'http', host: list(q.host), path: q.path || '/' };
    return null;
  }

  function parseVmess(uri) {
    const raw = b64decode(uri.slice('vmess://'.length));
    if (!raw) return null;
    let j;
    try { j = JSON.parse(raw); } catch (e) { return null; }
    const q = { type: j.net, host: j.host, path: j.path, security: j.tls ? 'tls' : '', sni: j.sni,
      alpn: j.alpn, fp: j.fp, headerType: j.type, serviceName: j.path };
    const tr = transportFrom(q);
    if (tr === null) return { unsupported: j.net, name: j.ps || j.add };
    return {
      name: j.ps || j.add,
      out: { type: 'vmess', server: j.add, server_port: Number(j.port) || 443, uuid: j.id,
        alter_id: Number(j.aid) || 0, security: j.scy || 'auto',
        tls: tlsFrom(q, j.add), transport: tr },
    };
  }

  function parseUri(uri) {
    uri = uri.trim();
    if (!uri) return null;
    if (/^vmess:\/\//i.test(uri)) return parseVmess(uri);
    const u = splitUri(uri);
    if (!u) return null;
    const name = u.name || `${u.host}:${u.port}`;
    const q = u.q;

    if (u.scheme === 'hysteria2' || u.scheme === 'hy2') {
      const out = { type: 'hysteria2', server: u.host, server_port: u.port, password: u.user,
        tls: tlsFrom(q, u.host, true) };
      if (q.obfs && q.obfs !== 'none') out.obfs = { type: q.obfs, password: q['obfs-password'] || '' };
      const hop = q.mport || q.ports;
      if (hop) {
        out.server_ports = list(hop).map(r => r.replace('-', ':')).map(r => r.includes(':') ? r : `${r}:${r}`);
        out.hop_interval = '30s';
      }
      if (q.upmbps) out.up_mbps = Number(q.upmbps);
      if (q.downmbps) out.down_mbps = Number(q.downmbps);
      return { name, out };
    }

    if (u.scheme === 'vless' || u.scheme === 'trojan') {
      const tr = transportFrom(q);
      if (tr === null) return { unsupported: q.type, name };
      const out = u.scheme === 'vless'
        ? { type: 'vless', server: u.host, server_port: u.port, uuid: u.user }
        : { type: 'trojan', server: u.host, server_port: u.port, password: u.user };
      if (u.scheme === 'vless' && q.flow) out.flow = q.flow;
      out.tls = tlsFrom(q, u.host, u.scheme === 'trojan' && (q.security || 'tls') !== 'none');
      if (tr) out.transport = tr;
      return { name, out };
    }

    if (u.scheme === 'ss') {
      let method, password, host = u.host, port = u.port;
      if (u.user) {
        const plain = u.user.includes(':') ? u.user : b64decode(u.user);
        if (!plain) return null;
        const i = plain.indexOf(':');
        method = plain.slice(0, i); password = plain.slice(i + 1);
      } else {
        // ss://base64(method:pass@host:port)
        const all = b64decode(uri.slice(5).split('#')[0]);
        if (!all) return null;
        const m = all.match(/^([^:]+):(.*)@([^@]+):(\d+)$/);
        if (!m) return null;
        [, method, password, host] = m; port = Number(m[4]);
      }
      return { name, out: { type: 'shadowsocks', server: host, server_port: port, method, password } };
    }

    if (u.scheme === 'tuic') {
      const [uuid, password] = u.user.split(':');
      return { name, out: { type: 'tuic', server: u.host, server_port: u.port, uuid, password,
        congestion_control: q.congestion_control || 'bbr', tls: tlsFrom(q, u.host, true) } };
    }
    return { unsupported: u.scheme, name };
  }

  /** Разбор ответа сервера подписки. resp = {status, body, headers} */
  function parseSubscription(resp) {
    let text = String(resp.body || '').trim();
    if (!text.includes('://')) {
      const d = b64decode(text);
      if (d && d.includes('://')) text = d;
    }
    const servers = [];
    const skipped = [];
    const used = new Set();
    text.split(/\r?\n/).forEach(line => {
      const r = parseUri(line);
      if (!r) return;
      if (r.unsupported) { skipped.push(`${r.name} (${r.unsupported})`); return; }
      let tag = (r.name || 'сервер').trim();
      let n = 2;
      while (used.has(tag)) tag = `${r.name} ${n++}`;
      used.add(tag);
      const out = JSON.parse(JSON.stringify(r.out));   // убираем undefined
      out.tag = tag;
      servers.push({ tag, type: out.type, host: out.server, out });
    });
    const h = resp.headers || {};
    const info = parseUserinfo(header(h, 'subscription-userinfo'));
    return {
      servers,
      skipped,
      title: maybeB64(header(h, 'profile-title')) || '',
      support: header(h, 'support-url') || '',
      announce: maybeB64(header(h, 'announce')) || '',
      updateHours: Number(header(h, 'profile-update-interval')) || 12,
      upload: info.upload || 0,
      download: info.download || 0,
      total: info.total || 0,
      expire: info.expire || 0,
    };
  }

  /**
   * Конфиг sing-box.
   * opts: {mode: 'proxy'|'tun', selected: tag|'auto', ruDirect: bool}
   */
  function buildConfig(servers, opts) {
    opts = opts || {};
    const tags = servers.map(s => s.tag);
    // «Авто» выбирает самый быстрый сервер только среди зарубежных
    const foreign = tags.filter(t => !isRussian(t));
    const autoTags = foreign.length ? foreign : tags;
    const sel = opts.selected && (opts.selected === 'auto' || tags.includes(opts.selected)) ? opts.selected : 'auto';
    const inbound = opts.mode === 'tun'
      ? { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], mtu: 9000,
          auto_route: true, strict_route: true, stack: 'system' }
      : { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: PROXY_PORT, set_system_proxy: true };

    const rules = [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' },
      { ip_is_private: true, outbound: 'direct' },
    ];
    const ruleSets = [];
    if (opts.ruDirect) {
      rules.push({ domain_suffix: ['ru', 'xn--p1ai', 'su', 'moscow', 'xn--80adxhks'], outbound: 'direct' });
      rules.push({ rule_set: ['geoip-ru'], outbound: 'direct' });
      ruleSets.push({ tag: 'geoip-ru', type: 'remote', format: 'binary',
        url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs',
        download_detour: 'proxy', update_interval: '7d' });
    }

    return {
      log: { level: 'info', timestamp: true },
      dns: {
        servers: [
          { tag: 'remote', address: 'https://1.1.1.1/dns-query', detour: 'proxy' },
          { tag: 'local', address: 'local', detour: 'direct' },
        ],
        rules: [{ outbound: 'any', server: 'local' }],
        final: 'remote',
        strategy: 'ipv4_only',
      },
      inbounds: [inbound],
      outbounds: [
        { type: 'selector', tag: 'proxy', outbounds: ['auto', ...tags], default: sel, interrupt_exist_connections: true },
        { type: 'urltest', tag: 'auto', outbounds: autoTags, url: 'https://www.gstatic.com/generate_204',
          interval: '3m', tolerance: 80 },
        ...servers.map(s => s.out),
        { type: 'direct', tag: 'direct' },
      ],
      route: Object.assign({ rules, final: 'proxy', auto_detect_interface: true },
        ruleSets.length ? { rule_set: ruleSets } : {}),
      experimental: {
        clash_api: { external_controller: `127.0.0.1:${CLASH_PORT}` },
        cache_file: { enabled: true },
      },
    };
  }

  // Флаг страны по названию сервера (если флага в названии нет)
  const COUNTRIES = [
    [/фин|finland|\bfi\b/i, '🇫🇮'], [/нидерл|netherl|holland|\bnl\b/i, '🇳🇱'], [/росси|russia|\bru\b/i, '🇷🇺'],
    [/герм|german|\bde\b/i, '🇩🇪'], [/франц|france|\bfr\b/i, '🇫🇷'], [/швец|sweden|\bse\b/i, '🇸🇪'],
    [/польш|poland|\bpl\b/i, '🇵🇱'], [/латв|latvia|\blv\b/i, '🇱🇻'], [/эстон|estonia|\bee\b/i, '🇪🇪'],
    [/сша|usa|united states|\bus\b/i, '🇺🇸'], [/брит|kingdom|\buk\b|\bgb\b/i, '🇬🇧'], [/казах|kazakh|\bkz\b/i, '🇰🇿'],
    [/турц|turk|\btr\b/i, '🇹🇷'],
  ];
  function flagOf(name) {
    const m = String(name).match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
    if (m) return m[0];
    const c = COUNTRIES.find(([re]) => re.test(name));
    return c ? c[1] : '🌐';
  }
  function isRussian(name) {
    return flagOf(name) === '🇷🇺';
  }
  function cleanName(name) {
    return String(name).replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim() || name;
  }

  const api = { parseSubscription, parseUri, buildConfig, flagOf, cleanName, isRussian, b64decode, PROXY_PORT, CLASH_PORT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TideSub = api;
})(typeof window !== 'undefined' ? window : globalThis);
