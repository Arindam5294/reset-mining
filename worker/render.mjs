// Renders state/race.svg: an animated hacker-terminal view of the header race for the repo README.
// Reads state/race.jsonl (racer) and state/activity.jsonl (balance). Pure SVG + CSS, so GitHub animates it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ist = (t) => { try { return new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }); } catch { return '--:--:--'; } };
const lines = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

export function render(SD = 'state') {
  const race = lines(join(SD, 'race.jsonl')), act = lines(join(SD, 'activity.jsonl'));
  const bal = [...act].reverse().find(a => a.balance != null) || {};
  const balance = bal.balance ?? '0.01000000', deposit = bal.deposit ?? '0.00000000';
  const posts = race.filter(r => r.step === 'post');
  const isWin = (r) => r.step === 'post' && !r.error && r.ok !== false;
  const wins = posts.filter(isWin).length, busy = posts.filter(r => String(r.message || '').includes('busy')).length;
  const lost = race.filter(r => r.step === 'lost').length;
  const blocks = new Set(posts.map(r => r.to_height).filter(Boolean)).size;
  const tip = Math.max(Number(bal.tip) || 0, ...race.map(r => Number(r.to_height || r.net_tip) || 0)) || '?';
  const goal = Math.min(100, ((Number(balance) + Number(deposit)) / 0.1) * 100);
  const last = race[race.length - 1] || {};
  const ageMin = last.t ? (Date.now() - new Date(last.t).getTime()) / 60000 : 999;
  const racing = ageMin < 20;
  const lastPost = [...race].reverse().find(r => r.step === 'post' || r.step === 'lost') || {};
  const state = isWin(lastPost) ? 'won' : lastPost.step === 'lost' ? 'lost' : String(lastPost.message || '').includes('busy') ? 'bounced' : 'waiting';

  const fmt = (r) => {
    const h = r.to_height ?? r.from_height ?? (String(r.why || '').split(':').pop());
    if (r.step === 'race_start') return ['boot', `[BOOT] racer v${r.v || 1} online · ${(r.sources || []).length || 1} feeds · stint ${r.minutes}m`];
    if (r.step === 'race_end') return ['dim', `[STINT END] calls ${r.calls} · wins ${r.posted}`];
    if (r.step === 'lost') return ['bad', `[LOST] #${r.net_tip ?? h} taken by a rival miner`];
    if (r.step === 'error') return ['bad', `[ERR] ${String(r.err || '').slice(0, 60)}`];
    if (isWin(r)) return ['win', `[WIN] HEADER #${h} POSTED FIRST  +0.003125 RESET`];
    if (String(r.message || '').includes('busy')) return ['warn', `[QUEUE FULL] #${h} bounced 64/64 · retry 1.7s · ${r.ms}ms`];
    if (r.outcome === 'unknown') return ['mag', `[??] #${h} sent, no receipt · may have landed`];
    if (r.raw) return ['bad', `[GATEWAY DOWN] no response · ${r.ms}ms`];
    return ['bad', `[REJECTED] #${h} ${String(r.message || r.outcome || '').slice(0, 44)}`];
  };
  const tail = race.slice(-13).map(r => [ist(r.t), ...fmt(r)]);

  const W = 880, H = 600;
  // 64-slot queue: 32 x 2 grid, rivals fill it; our bot sits per state
  let slots = '';
  for (let i = 0; i < 64; i++) {
    const x = 28 + (i % 32) * 26, y = 168 + Math.floor(i / 32) * 26;
    const ours = (state === 'won' && i === 0);
    const cls = ours ? 'me' : racing ? 'rival' : 'idle';
    slots += `<rect class="${cls}" x="${x}" y="${y}" width="20" height="20" rx="3" style="animation-delay:${(i * 0.05).toFixed(2)}s"/>`;
  }
  const meX = state === 'won' ? 28 : 28 + 32 * 26 - 6;
  const me = state === 'won' ? '' : `<g class="${state === 'bounced' ? 'bounce' : 'hover'}"><rect class="me" x="${meX - 18}" y="181" width="20" height="20" rx="3"/><text class="tag" x="${meX - 8}" y="232" text-anchor="middle">YOU</text></g>`;
  const label = { won: 'WE HOLD SLOT #1', lost: 'RIVAL GOT THE LAST BLOCK', bounced: 'BOUNCED · SHOVING BACK IN', waiting: 'WAITING FOR NEXT BITCOIN BLOCK' }[state];

  const logY = 270;
  const log = tail.map(([t, c, s], i) => `<g class="ln" style="animation-delay:${(0.4 + i * 0.25).toFixed(2)}s"><text x="28" y="${logY + i * 22}" class="ts">${t}</text><text x="104" y="${logY + i * 22}" class="${c}">${esc(s)}</text></g>`).join('');
  const curY = logY + tail.length * 22;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
<style>
text{font-size:13px;fill:#7CFFB2}
.title{font-size:20px;font-weight:700;fill:#39FF88;letter-spacing:2px;animation:glitch 3s infinite steps(1)}
.sub{fill:#2fd3ff}.k{fill:#5a8f73;font-size:11px}.v{font-size:17px;font-weight:700;fill:#eafff3}
.ts{fill:#3f6b56}.boot{fill:#2fd3ff}.dim{fill:#5a8f73}.bad{fill:#ff4d6d}.warn{fill:#ffd23f}.mag{fill:#ff5cf0}.win{fill:#39FF88;font-weight:700}
.tag{font-size:10px;fill:#2fd3ff;font-weight:700}
.rival{fill:#26332c;stroke:#3c5a49;animation:jam 1.2s infinite alternate}
.idle{fill:#141c18;stroke:#22302a;animation:breathe 4s infinite}
.me{fill:#2fd3ff;filter:drop-shadow(0 0 6px #2fd3ff)}
.hover{animation:nudge 1.1s infinite ease-in-out}.bounce{animation:kick 1.4s infinite}
.ln{opacity:0;animation:in .4s forwards}
.cur{animation:blink 1s infinite steps(1)}
.scan{animation:scan 6s infinite linear}
.led{animation:blink 1.4s infinite}
@keyframes in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
@keyframes blink{50%{opacity:0}}
@keyframes jam{to{fill:#33463b}}
@keyframes breathe{50%{opacity:.4}}
@keyframes nudge{50%{transform:translateX(-10px)}}
@keyframes kick{0%,100%{transform:none}30%{transform:translateX(-14px)}55%{transform:translateX(10px) translateY(-6px)}}
@keyframes glitch{0%,92%{transform:none}93%{transform:translateX(2px);fill:#ff4d6d}95%{transform:translateX(-2px);fill:#2fd3ff}97%{transform:none}}
@keyframes scan{from{transform:translateY(-40px)}to{transform:translateY(${H}px)}}
</style>
<defs><pattern id="sl" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".35"/></pattern>
<linearGradient id="bar"><stop offset="0" stop-color="#39FF88"/><stop offset="1" stop-color="#2fd3ff"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="12" fill="#05090a"/>
<rect width="${W}" height="30" rx="12" fill="#0d1512"/><circle cx="20" cy="15" r="5" fill="#ff5f57"/><circle cx="38" cy="15" r="5" fill="#febc2e"/><circle cx="56" cy="15" r="5" fill="#28c840"/>
<text x="${W / 2}" y="19" text-anchor="middle" class="k">swanix@reset-miner: ~/header-race</text>
<text x="28" y="62" class="title">RESET://HEADER-RACE</text>
<circle class="led" cx="${W - 150}" cy="56" r="6" fill="${racing ? '#39FF88' : '#ffb020'}"/><text x="${W - 138}" y="61" class="${racing ? 'win' : 'warn'}">${racing ? 'RACING' : 'IDLE'}</text>
<text x="28" y="84" class="k">first poster of each Bitcoin header wins 0.003125 RESET · updated ${esc(ist(new Date().toISOString()))} IST</text>
${[['BALANCE', Number(balance).toFixed(4) + ' RESET'], ['WINS', wins], ['BLOCKS FOUGHT', blocks], ['BOUNCED', busy], ['LOST', lost], ['BTC TIP', tip]].map(([k, v], i) => `<text x="${28 + i * 140}" y="112" class="k">${k}</text><text x="${28 + i * 140}" y="133" class="v">${esc(v)}</text>`).join('')}
<rect x="28" y="144" width="${W - 56}" height="6" rx="3" fill="#13201a"/><rect x="28" y="144" width="${((W - 56) * goal / 100).toFixed(1)}" height="6" rx="3" fill="url(#bar)"/>
<text x="${W - 28}" y="162" text-anchor="end" class="k">${goal.toFixed(0)}% of 0.1 RESET needed to mine</text>
<text x="28" y="162" class="k">GATEWAY QUEUE 64 SLOTS · FIRST COME · ${label}</text>
${slots}${me}
<line x1="28" x2="${W - 28}" y1="248" y2="248" stroke="#13201a"/>
${log}
<text x="28" y="${curY}" class="sub">$ <tspan class="cur">█</tspan></text>
<rect width="${W}" height="${H}" rx="12" fill="url(#sl)" pointer-events="none"/>
<rect class="scan" width="${W}" height="40" fill="#39FF88" opacity=".04"/>
</svg>`;
  writeFileSync(join(SD, 'race.svg'), svg);
}
if (import.meta.url === `file://${process.argv[1]}`) render(process.env.STATE_DIR || 'state');
