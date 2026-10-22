// RESET header racer v3. Watches several Bitcoin sources at once (mempool.space websocket push + fast polling of
// blockstream.info and mempool.emzy.de) and calls post_headers the instant any of them shows a block the RESET network
// does not have yet. The signer reads headers from a local proxy (127.0.0.1) that always answers from the source with
// the highest tip, so it never waits on a slow source. The first poster of each header earns 0.003125 RESET.
// Only ever calls post_headers (no TNK fee, no move of funds). Env: RESET_SIGNER_BIN, RESET_SIGNER_DIRECTORY,
// RESET_SIGNER_PASSWORD, STATE_DIR, RACE_MINUTES (default 340), RACE_POLL_MS (default 2000), RACE_PUSH.
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { render } from './render.mjs';
const env = process.env, BIN = env.RESET_SIGNER_BIN, SD = env.STATE_DIR || 'state'; mkdirSync(SD, { recursive: true });
const LOG = join(SD, 'race.jsonl');
const log = (o) => { const e = { t: new Date().toISOString(), ...o }; appendFileSync(LOG, JSON.stringify(e) + '\n'); console.log(JSON.stringify(e)); };
const end = Date.now() + Number(env.RACE_MINUTES || 340) * 60000, POLL = Number(env.RACE_POLL_MS || 2000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (!env.RESET_SIGNER_PASSWORD || !existsSync(join(env.RESET_SIGNER_DIRECTORY || '', 'keystore.json'))) { console.log('{"stop":"no wallet"}'); process.exit(0); }

// ---- Bitcoin sources ----
const SOURCES = ['https://mempool.space', 'https://blockstream.info', 'https://mempool.emzy.de'];
const tips = Object.fromEntries(SOURCES.map(s => [s, { h: 0, at: 0 }]));
let wake = null; const kick = (why) => { if (wake) { const w = wake; wake = null; w(why); } };
let netTip = 0; // RESET network tip as last reported by post_headers
function seen(src, h, how) {
  if (!Number.isInteger(h) || h <= tips[src].h) return;
  tips[src] = { h, at: Date.now() };
  if (h > netTip) { firstSeen[h] ??= { src, how, at: Date.now() }; kick(`${how}:${src.split('//')[1]}:${h}`); }
}
const firstSeen = {};
const get = async (base, path, ms = 2500) => { const r = await fetch(base + path, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(r.status); return (await r.text()).trim(); };
async function poll(src, every) {
  while (Date.now() < end) { try { seen(src, Number(await get(src, '/api/blocks/tip/height')), 'poll'); } catch {} await sleep(every); }
}
function ws() { // mempool.space pushes each new block the moment it sees it
  if (typeof WebSocket === 'undefined' || Date.now() >= end) return;
  let s; try { s = new WebSocket('wss://mempool.space/api/v1/ws'); } catch { return setTimeout(ws, 5000); }
  s.onopen = () => s.send(JSON.stringify({ action: 'want', data: ['blocks'] }));
  s.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.block?.height) seen(SOURCES[0], d.block.height, 'push');
    if (Array.isArray(d.blocks)) for (const b of d.blocks) seen(SOURCES[0], b.height, 'push'); } catch {} };
  s.onclose = () => setTimeout(ws, 3000); s.onerror = () => { try { s.close(); } catch {} };
}

// ---- local proxy the signer reads headers from: best (highest-tip) source first, others as fallback ----
const ranked = () => SOURCES.slice().sort((a, b) => tips[b].h - tips[a].h);
const cache = new Map(); // block hash -> header, block-height -> hash (immutable enough within a stint)
const server = createServer(async (req, res) => {
  const path = req.url;
  try {
    if (path === '/api/blocks/tip/height') {
      const best = Math.max(...SOURCES.map(s => tips[s].h));
      if (best > 0) { res.end(String(best)); return; }
    }
    if (cache.has(path)) { res.end(cache.get(path)); return; }
    for (const src of ranked()) {
      try { const v = await get(src, path, 2000); if (path.includes('/header') || path.startsWith('/api/block-height/')) {
          if (!path.startsWith('/api/block-height/') || tips[src].h - Number(path.split('/').pop()) >= 2) cache.set(path, v); }
        res.end(v); return; } catch {}
    }
    res.statusCode = 502; res.end('');
  } catch { res.statusCode = 500; res.end(''); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${server.address().port}`;

// ---- signers: several lanes, so a new submission can start while slow ones are still in flight ----
// The gateway counts only POST /v1/move against the 60/min per-address limit (and 240/min per IP for everything),
// so submissions are spaced by a shared limiter at RACE_GAP_MS (default 1100 ms ~ 55/min), not by each lane's round trip.
const req = createRequire(join(dirname(BIN), '..', 'package.json'));
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const LANES = Number(env.RACE_LANES || 4), GAP = Math.max(1050, Number(env.RACE_GAP_MS || 1100));
const lanes = Array.from({ length: LANES }, () => ({ client: null }));
async function connect(l) {
  try { await l.client?.close(); } catch {}
  l.client = new Client({ name: 'reset-race', version: '3' });
  await l.client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], stderr: 'pipe',
    env: { PATH: env.PATH, HOME: env.HOME || '/tmp', RESET_SIGNER_DIRECTORY: env.RESET_SIGNER_DIRECTORY,
      RESET_SIGNER_PASSWORD: env.RESET_SIGNER_PASSWORD, RESET_HEADER_SOURCE: PROXY } }));
}
let nextSlot = 0, cool = 0;
async function slot() { for (;;) { const now = Date.now(), at = Math.max(nextSlot, cool); if (now >= at) { nextSlot = now + GAP; return; } await sleep(at - now); } }
// pushes run in the background and are coalesced, so git never blocks a fight
let pushing = false, dirty = false;
function push() { dirty = true; if (pushing) return; pushing = true; dirty = false; try { render(SD); } catch {}
  if (!env.RACE_PUSH) { pushing = false; return; }
  exec(`git add ${LOG} ${join(SD, 'race.svg')} && git commit -qm "race: header post" && (git push -q || (git pull -q --rebase -X theirs && git push -q) || (git pull -q --rebase -X theirs && git push -q))`, { timeout: 60000 },
    () => { setTimeout(() => { pushing = false; if (dirty) push(); }, 15000); }); }

ws(); poll(SOURCES[1], POLL); poll(SOURCES[2], POLL + 1000); poll(SOURCES[0], 15000); // mempool.space mostly via push
let posted = 0, calls = 0, errors = 0;
log({ step: 'race_start', v: 3, minutes: Number(env.RACE_MINUTES || 340), poll_ms: POLL, lanes: LANES, gap_ms: GAP, sources: SOURCES });
await Promise.all(lanes.map(l => connect(l).catch(() => { l.client = null; })));

async function attempt(l, why) {
  await slot(); const t0 = Date.now();
  try {
    if (!l.client) await connect(l);
    const r = await l.client.callTool({ name: 'post_headers', arguments: {} }, undefined, { timeout: 90000 });
    calls++; errors = 0;
    const text = r.content?.map(c => c.text).join('\n') ?? ''; let d; try { d = JSON.parse(text); } catch { d = { raw: text.slice(0, 300) }; }
    if (Number.isInteger(d.tip)) netTip = Math.max(netTip, d.tip);
    const won = !r.isError && d.ok !== false && d.outcome !== 'nothing_new';
    if (won && Number.isInteger(d.to_height)) netTip = Math.max(netTip, d.to_height);
    if (/rate/.test(String(d.message || d.raw || ''))) cool = Date.now() + 5000;   // address/ip rate hit: back off
    if (d.outcome === 'nothing_new') return { done: true, d, ms: Date.now() - t0 };
    if (won) posted++;
    const fs = firstSeen[d.to_height ?? d.from_height];
    log({ step: 'post', why, error: !!r.isError, ms: Date.now() - t0, since_seen_ms: fs ? Date.now() - fs.at : null, first_seen: fs?.src, ...d });
    return { done: won, d };
  } catch (e) {
    errors++; log({ step: 'error', n: errors, why, err: String(e.message || e).slice(0, 200) });
    l.client = null; cool = Math.max(cool, Date.now() + Math.min(20000, 2000 * errors)); return { done: false };
  }
}
// a fight: all lanes fire at the shared pace until the network has every header our sources know
async function fight(why) {
  const target = Math.max(...SOURCES.map(s => tips[s].h)), startNet = netTip; let over = false, result = null;
  await Promise.all(lanes.map(async (l, i) => {
    await sleep(i * 50);
    while (!over && Date.now() < end) {
      const a = await attempt(l, why);
      if (a.done) { over = true; result ??= a; }
      if (Math.max(...SOURCES.map(s => tips[s].h)) <= netTip && netTip >= target) over = true;
      why = 'retry';
    }
  }));
  if (result?.d?.outcome === 'nothing_new' && startNet > 0 && target > startNet) {
    const fs = firstSeen[target];
    log({ step: 'lost', net_tip: netTip, target, since_seen_ms: fs ? Date.now() - fs.at : null });
  }
  push();
}
let why = 'start';
while (Date.now() < end) {
  const best = Math.max(...SOURCES.map(s => tips[s].h));
  if (why === 'heartbeat' && best <= netTip) { await attempt(lanes[0], 'heartbeat'); }   // keep netTip fresh, no fight
  else await fight(why);
  let hb; why = await new Promise(r => { wake = r; hb = setTimeout(() => kick('heartbeat'), 30000); }); clearTimeout(hb);
}
log({ step: 'race_end', calls, posted }); push();
await sleep(20000);
for (const l of lanes) try { await l.client?.close(); } catch {}
server.close(); process.exit(0);
