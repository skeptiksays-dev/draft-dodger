// Dota 2 Game State Integration for Draft Dodger.
// Finds Dota, installs the GSI config file, checks the launch option and runs the
// local server Dota sends its updates to. Plain Node.js (no Electron) so it can be tested alone.
// GSI is Valve's official feature: Dota sends this data on purpose. Nothing here reads game memory.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const PORT = 53000;
const CFG_NAME = 'gamestate_integration_draftdodger.cfg';
const ALLOWED_ORIGINS = ['https://draftdodger.netlify.app'];
const LOG_LIMIT = 8 * 1024 * 1024;

// Same file the standalone helper installs, so the two are interchangeable.
function cfgText(port = PORT) {
  return [
    '"Draft Dodger"',
    '{',
    `    "uri"           "http://localhost:${port}/"`,
    '    "timeout"       "5.0"',
    '    "buffer"        "0.1"',
    '    "throttle"      "0.5"',
    '    "heartbeat"     "10.0"',
    '    "data"',
    '    {',
    '        "provider"      "1"',
    '        "map"           "1"',
    '        "player"        "1"',
    '        "hero"          "1"',
    '        "draft"         "1"',
    '    }',
    '}',
    ''
  ].join('\n');
}

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = out.match(new RegExp(value + '\\s+REG_\\w+\\s+(.+)'));
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

// Where Steam is installed, most likely first.
function steamRoots({ reg = regQuery, platform = process.platform, env = process.env } = {}) {
  const roots = [];
  if (platform === 'win32') {
    for (const [key, value] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
                                ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
                                ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']]) {
      const p = reg(key, value);
      if (p) roots.push(path.normalize(p.replace(/\//g, '\\')));
    }
    roots.push('C:\\Program Files (x86)\\Steam');
  } else {
    const home = env.HOME || '';
    roots.push(path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'),
               path.join(home, 'Library', 'Application Support', 'Steam'));
  }
  return [...new Set(roots)];
}

// A Steam install plus every extra library listed in libraryfolders.vdf.
function libraryRoots(root) {
  const out = [root];
  try {
    const text = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) out.push(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch (e) { /* no extra libraries */ }
  return [...new Set(out)];
}

function findDota({ roots } = {}) {
  roots = roots || steamRoots();
  for (const root of roots) {
    for (const lib of libraryRoots(root)) {
      const cfgDir = path.join(lib, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg');
      if (fs.existsSync(cfgDir)) return { steamRoot: root, cfgDir };
    }
  }
  return null;
}

// Accepts whatever folder someone picks by hand: the Steam folder, the Dota folder, or the cfg folder.
function cfgDirFrom(picked) {
  const tries = [
    picked,
    path.join(picked, 'cfg'),
    path.join(picked, 'dota', 'cfg'),
    path.join(picked, 'game', 'dota', 'cfg'),
    path.join(picked, 'dota 2 beta', 'game', 'dota', 'cfg'),
    path.join(picked, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg')
  ];
  return tries.find(p => path.basename(p) === 'cfg' && fs.existsSync(p)) || null;
}

function installCfg(cfgDir, port = PORT) {
  const dir = path.join(cfgDir, 'gamestate_integration');
  const file = path.join(dir, CFG_NAME);
  const text = cfgText(port);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== null && current.replace(/\r\n/g, '\n') === text) return { status: 'ok', path: file };
    fs.writeFileSync(file, text, 'utf8');          // UTF-8 without a byte-order mark
    return { status: current === null ? 'installed' : 'updated', path: file };
  } catch (e) {
    return { status: 'error', path: file, message: e.message };
  }
}

// Body of the first `"<appid>" { ... }` block that holds launch options (balanced braces, quote aware).
function appBlock(text, appid) {
  const re = new RegExp('"' + appid + '"\\s*\\{', 'g');
  let m, first = null;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    while (i < text.length && depth) {
      const c = text[i];
      if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } }
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const body = text.slice(re.lastIndex, i - 1);
    if (/"LaunchOptions"/i.test(body)) return body;
    if (first === null) first = body;
  }
  return first;
}

// 'yes' if any Steam user on this PC has -gamestateintegration set for Dota, 'no' if Dota's settings
// were found without it, 'unknown' if Steam's per-user settings couldn't be read.
function launchOptionStatus(roots) {
  roots = roots || steamRoots();
  let sawDota = false;
  for (const root of roots) {
    let users = [];
    try { users = fs.readdirSync(path.join(root, 'userdata')); } catch (e) { continue; }
    for (const u of users) {
      let text;
      try { text = fs.readFileSync(path.join(root, 'userdata', u, 'config', 'localconfig.vdf'), 'utf8'); } catch (e) { continue; }
      const block = appBlock(text, '570');
      if (block === null) continue;
      sawDota = true;
      const m = block.match(/"LaunchOptions"\s+"((?:[^"\\]|\\.)*)"/i);
      if (m && /(^|\s)-gamestateintegration(\s|$)/i.test(m[1])) return 'yes';
    }
  }
  return sawDota ? 'no' : 'unknown';
}

// Local server: Dota POSTs updates here; the app (and the Draft Dodger website) read /state.
function createGsiServer({ port = PORT, logFile = null, onPhase = () => {}, allowedOrigins = ALLOWED_ORIGINS, version = '' } = {}) {
  const st = { latest: null, count: 0, lastAt: null, sawDraft: false, phase: null, error: null, errorMessage: '' };
  let logBytes = 0;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fs.existsSync(logFile)) fs.renameSync(logFile, logFile.replace(/\.jsonl$/, '-previous.jsonl'));
    } catch (e) { /* logging is optional */ }
  }
  const okOrigin = o => !!o && (allowedOrigins.includes(o) || /^http:\/\/localhost(:\d+)?$/.test(o));

  function ingest(body) {
    let data;
    try { data = JSON.parse(body); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;
    st.latest = data; st.count++; st.lastAt = Date.now();
    const phase = String((data.map && data.map.game_state) || '').replace('DOTA_GAMERULES_STATE_', '');
    const hasDraft = !!(data.draft && typeof data.draft === 'object' && Object.keys(data.draft).length);
    if (hasDraft) st.sawDraft = true;
    if (phase !== st.phase) {
      const prev = st.phase; st.phase = phase;
      try { onPhase(phase, prev, hasDraft); } catch (e) { /* ignore listener errors */ }
    }
    if (logFile && logBytes < LOG_LIMIT && !/GAME_IN_PROGRESS|POST_GAME/.test(phase)) {
      const line = JSON.stringify({ t: st.lastAt, data }) + '\n';
      logBytes += line.length;
      fs.appendFile(logFile, line, () => {});
    }
  }
  function snapshot() {
    return { helper: 'draftdodger', app: true, version, received: st.count, lastAt: st.lastAt,
             sawDraft: st.sawDraft, state: st.latest, error: st.error, message: st.errorMessage };
  }
  function handler(req, res) {
    const origin = req.headers.origin;
    const allowed = okOrigin(origin);
    if (allowed) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
                           'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => { if (!origin) ingest(body); res.writeHead(200); res.end(); });   // web pages can't post fake game data
      return;
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/state') {
      if (origin && !allowed) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(snapshot()));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Draft Dodger is listening for Dota. Updates received: ' + st.count);
  }
  // Dota's "localhost" may resolve to IPv4 or IPv6, so listen on both loopback addresses (never the network).
  const servers = [];
  function listenOn(host) {
    return new Promise(resolve => {
      const s = http.createServer(handler);
      s.once('error', e => resolve({ ok: false, code: e.code, message: e.message }));
      s.listen(port, host, () => { servers.push(s); resolve({ ok: true }); });
    });
  }
  return {
    async start() {
      const v4 = await listenOn('127.0.0.1');
      if (!v4.ok) {
        st.error = v4.code === 'EADDRINUSE' ? 'port' : 'server';
        st.errorMessage = v4.code === 'EADDRINUSE'
          ? `Port ${port} is already in use. If the separate Draft Dodger helper window is open, close it.`
          : v4.message;
        return false;
      }
      await listenOn('::1');   // fine if IPv6 isn't available
      return true;
    },
    snapshot,
    get error() { return st.error; },
    close() { return Promise.all(servers.map(s => new Promise(r => s.close(() => r())))); }
  };
}

module.exports = { PORT, CFG_NAME, cfgText, steamRoots, libraryRoots, findDota, cfgDirFrom, installCfg,
                   appBlock, launchOptionStatus, createGsiServer };
