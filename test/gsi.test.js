'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const gsi = require('../gsi');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dd-')); }
function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

test('finds Dota in a second Steam library and installs the config', () => {
  const steam = tmp(), lib = tmp();
  fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
  fs.writeFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib}"\n\t}\n}\n`);
  const cfg = path.join(lib, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  const found = gsi.findDota({ roots: [steam] });
  assert.ok(found, 'should find Dota');
  assert.strictEqual(found.cfgDir, cfg);
  const r1 = gsi.installCfg(found.cfgDir);
  assert.strictEqual(r1.status, 'installed');
  const text = fs.readFileSync(r1.path, 'utf8');
  assert.match(text, /"uri"\s+"http:\/\/localhost:53000\/"/);
  assert.match(text, /"draft"\s+"1"/);
  assert.ok(!text.startsWith('\ufeff'), 'no byte-order mark');
  assert.strictEqual(gsi.installCfg(found.cfgDir).status, 'ok');
  fs.writeFileSync(r1.path, 'old');
  assert.strictEqual(gsi.installCfg(found.cfgDir).status, 'updated');
  assert.strictEqual(gsi.cfgDirFrom(path.join(lib, 'steamapps', 'common', 'dota 2 beta')), cfg);
  assert.strictEqual(gsi.cfgDirFrom(lib), cfg);
  assert.strictEqual(gsi.findDota({ roots: [tmp()] }), null);
});

test('reads the launch option from Steam user settings', () => {
  const steam = tmp();
  const write = (user, opts) => {
    const dir = path.join(steam, 'userdata', user, 'config'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'localconfig.vdf'),
      `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n` +
      `\t\t\t\t\t"440"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"-novid"\n\t\t\t\t\t}\n` +
      `\t\t\t\t\t"570"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1700000000"\n\t\t\t\t\t\t"cloud"\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\t"last_sync_state"\t\t"synchronized"\n\t\t\t\t\t\t}\n` +
      (opts === null ? '' : `\t\t\t\t\t\t"LaunchOptions"\t\t"${opts}"\n`) +
      `\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`);
  };
  assert.strictEqual(gsi.launchOptionStatus([steam]), 'unknown');
  write('111', null);
  assert.strictEqual(gsi.launchOptionStatus([steam]), 'no');
  write('111', '-novid -high');
  assert.strictEqual(gsi.launchOptionStatus([steam]), 'no');
  write('222', '-novid -gamestateintegration -high');
  assert.strictEqual(gsi.launchOptionStatus([steam]), 'yes');
});

test('server takes Dota updates, serves /state with the right CORS rules, and logs the draft', async () => {
  const port = 53100 + Math.floor(Math.random() * 500);
  const logFile = path.join(tmp(), 'logs', 'gsi-log.jsonl');
  const phases = [];
  const srv = gsi.createGsiServer({ port, logFile, onPhase: (p, prev, d) => phases.push([p, d]), version: '0.8.0' });
  assert.strictEqual(await srv.start(), true);
  const payload = JSON.stringify({ map: { matchid: '9', game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' },
    player: { team_name: 'dire' }, hero: { id: 5 }, draft: { team2: { pick0_id: 9 } } }, null, '\t');
  assert.strictEqual((await req(port, 'POST', '/', { body: payload })).status, 200);
  // a web page trying to post fake data is ignored
  await req(port, 'POST', '/', { body: '{"map":{"game_state":"DOTA_GAMERULES_STATE_POST_GAME"}}', headers: { Origin: 'https://evil.example' } });
  const ok = await req(port, 'GET', '/state', { headers: { Origin: 'https://draftdodger.netlify.app' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.headers['access-control-allow-origin'], 'https://draftdodger.netlify.app');
  const st = JSON.parse(ok.body);
  assert.strictEqual(st.received, 1);
  assert.strictEqual(st.sawDraft, true);
  assert.strictEqual(st.state.hero.id, 5);
  assert.deepStrictEqual(phases, [['HERO_SELECTION', true]]);
  assert.strictEqual((await req(port, 'GET', '/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await req(port, 'GET', '/state', { headers: { Origin: 'http://localhost.evil.example' } })).status, 403);
  assert.strictEqual((await req(port, 'GET', '/state', { headers: { Origin: 'http://localhost:8765' } })).status, 200);
  const pre = await req(port, 'OPTIONS', '/state', { headers: { Origin: 'https://draftdodger.netlify.app', 'Access-Control-Request-Private-Network': 'true' } });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(pre.headers['access-control-allow-private-network'], 'true');
  await new Promise(r => setTimeout(r, 100));
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).data.hero.id, 5);
  // a second copy can't start on the same port and says why
  const second = gsi.createGsiServer({ port });
  assert.strictEqual(await second.start(), false);
  assert.strictEqual(second.snapshot().error, 'port');
  await srv.close();
});
