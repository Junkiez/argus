import fs from 'node:fs';
import path from 'node:path';
import type { Config, Result, Summary } from './types.ts';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
export const fmtPct = (n: number) => `${n.toFixed(n < 1 ? 3 : 2)}%`;
const pct = (r: Result) => (r.status === 'error' ? 'error' : fmtPct(r.diffPercentage ?? 0));
const tone = (r: Result) => (r.status === 'error' ? 'err' : r.failed ? 'bad' : r.status === 'match' ? 'ok' : 'warn');
const id = (r: Result) => `r-${r.page}-${r.viewport}`.replace(/[^\w-]/g, '_');

function detail(r: Result, rel: (f: string) => string) {
  const head = `<summary><span class="dot ${tone(r)}"></span><b>${esc(r.page)}</b> <span class="muted">${esc(r.viewport)}</span>
    <span class="pct ${tone(r)}">${pct(r)}</span></summary>`;
  const refLabel = r.refType === 'image' ? 'reference' : 'remote';
  const refLink = r.refType === 'image' ? `image <code>${esc(rel(r.remote))}</code>` : `remote <a href="${esc(r.remoteUrl)}">${esc(r.remoteUrl)}</a>`;
  const links = `<p class="muted">${refLink} · local <a href="${esc(r.localUrl)}">${esc(r.localUrl)}</a></p>`;
  if (r.status === 'error') return `<details id="${id(r)}" class="card" open>${head}${links}<p class="errmsg">${esc(r.error)}</p></details>`;

  const s = r.size!;
  const bandList = r.bands ?? [];
  const facts = [
    `${(r.diffCount ?? 0).toLocaleString('en')} px changed`,
    `${refLabel} ${s.remote.width}×${s.remote.height}`,
    `local ${s.local.width}×${s.local.height}`,
  ];
  const sizeNote = r.sizeMismatch
    ? `<p class="warnmsg">Page size differs (height ${s.local.height - s.remote.height > 0 ? '+' : ''}${s.local.height - s.remote.height}px locally). Only the overlapping area is pixel-compared${r.refType === 'image' ? '. Design frames often have a different height than the real page, so this is a warning only' : ', so look for missing or extra content first'}.</p>`
    : '';
  // Bands are in remote-image coordinates (the diff image has the remote's size).
  const H = s.remote.height || 1;
  const overlay = bandList.map((b, i) =>
    `<a class="band" href="#${id(r)}-b${i}" style="top:${(b.y1 / H) * 100}%;height:${Math.max((b.height / H) * 100, 0.3)}%" title="y ${b.y1}–${b.y2}"></a>`).join('');
  const bands = bandList.length
    ? `<table class="bands"><thead><tr><th>#</th><th>y (px)</th><th>height</th><th>where</th></tr></thead><tbody>${bandList.map((b, i) =>
        `<tr id="${id(r)}-b${i}"><td>${i + 1}</td><td>${b.y1}–${b.y2}</td><td>${b.height}px</td><td>${b.where.map((w) => `<code>${esc(w)}</code>`).join(' ') || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`
    : '';
  const img = (f: string, cls: string) => `<img class="${cls}" loading="lazy" src="${esc(rel(f))}" alt="${cls}">`;
  const viewer = `<div class="viewer" data-mode="diff">
    <div class="modes">${['diff', 'remote', 'local', 'side'].map((m) => `<button data-m="${m}">${m === 'side' ? 'side by side' : m === 'remote' ? refLabel : m}</button>`).join('')}</div>
    <div class="stage" style="max-width:${s.remote.width}px"><div class="frame">${img(r.diff, 'diff')}${overlay}</div>${img(r.remote, 'remote')}${img(r.local, 'local')}</div>
    <div class="side">${img(r.remote, 'x')}${img(r.local, 'x')}${img(r.diff, 'x')}</div>
  </div>`;
  return `<details id="${id(r)}" class="card"${r.failed ? ' open' : ''}>${head}${links}<p class="facts">${facts.join(' · ')}</p>${sizeNote}${bands}${viewer}</details>`;
}

export function writeReport(summary: Summary, cfg: Config): string {
  const dir = path.dirname(cfg.report);
  fs.mkdirSync(dir, { recursive: true });
  const rel = (f: string) => path.relative(dir, f).split(path.sep).join('/');
  const { results, counts, threshold } = summary;
  const pages = [...new Set(results.map((r) => r.page))];
  const vps = [...new Set(results.map((r) => r.viewport))];
  const by = new Map(results.map((r) => [`${r.page}@${r.viewport}`, r]));
  const matrix = `<table class="matrix"><thead><tr><th>page</th>${vps.map((v) => `<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${pages.map((p) =>
    `<tr><td>${esc(p)}</td>${vps.map((v) => {
      const r = by.get(`${p}@${v}`);
      return r ? `<td><a class="pct ${tone(r)}" href="#${id(r)}">${pct(r)}${r.sizeMismatch ? ' ↕' : ''}</a></td>` : '<td></td>';
    }).join('')}</tr>`).join('')}</tbody></table>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Argus report</title>
<style>
:root{--bg:#fafafa;--fg:#1a1a1a;--muted:#6b6b6b;--card:#fff;--line:#e4e4e4;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#e8e8e8;--muted:#9a9a9a;--card:#1b1b1b;--line:#2e2e2e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}a{color:var(--accent)}h1{font-size:22px;margin:0 0 4px}
.muted{color:var(--muted)}.chips{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.chip{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px}
.chip b{font-size:20px;display:block}table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left}
.matrix{border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:24px}.pct{font-variant-numeric:tabular-nums;font-weight:600;text-decoration:none}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad,.err{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
summary{cursor:pointer;display:flex;gap:10px;align-items:center}summary .pct{margin-left:auto}
.dot{width:10px;height:10px;border-radius:50%;background:currentColor;display:inline-block}
.dot.ok{color:var(--ok)}.dot.warn{color:var(--warn)}.dot.bad,.dot.err{color:var(--bad)}
.errmsg,.warnmsg{padding:8px 10px;border-radius:6px;border:1px solid}.errmsg{color:var(--bad)}.warnmsg{color:var(--warn)}
.bands{margin:8px 0;font-size:13px}code{font-size:12px;background:var(--bg);padding:1px 5px;border-radius:4px;border:1px solid var(--line)}
.modes{display:flex;gap:4px;margin:10px 0}.modes button{font:inherit;padding:4px 10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;cursor:pointer}
.viewer[data-mode=diff] [data-m=diff],.viewer[data-mode=remote] [data-m=remote],.viewer[data-mode=local] [data-m=local],.viewer[data-mode=side] [data-m=side]{background:var(--accent);color:#fff;border-color:var(--accent)}
img{display:block;max-width:100%;height:auto;border:1px solid var(--line)}
.stage img.remote,.stage img.local,.side{display:none}
.viewer[data-mode=remote] .frame,.viewer[data-mode=local] .frame{display:none}
.viewer[data-mode=remote] img.remote,.viewer[data-mode=local] img.local{display:block}
.viewer[data-mode=side] .stage{display:none}.viewer[data-mode=side] .side{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;align-items:start}
.frame{position:relative}.band{position:absolute;left:0;right:0;background:color-mix(in srgb,var(--bad) 18%,transparent);border-left:4px solid var(--bad)}
</style></head><body><main>
<h1>Argus report</h1>
<p class="muted">${esc(new Date().toISOString())} · ${cfg.remote ? `remote <a href="${esc(cfg.remote)}">${esc(cfg.remote)}</a>` : 'reference images'}${cfg.remote && cfg.refs ? ` + images <code>${esc(cfg.refs)}</code>` : ''} vs local <a href="${esc(cfg.local.url)}">${esc(cfg.local.url)}</a> · threshold ${threshold}%</p>
<div class="chips"><div class="chip"><b class="${summary.ok ? 'ok' : 'bad'}">${summary.ok ? 'PASS' : 'FAIL'}</b>result</div>
<div class="chip"><b>${counts.total}</b>checks</div><div class="chip"><b class="ok">${counts.passed}</b>passed</div>
<div class="chip"><b class="bad">${counts.failed}</b>over threshold</div><div class="chip"><b class="bad">${counts.errors}</b>errors</div></div>
${matrix}
${results.map((r) => detail(r, rel)).join('\n')}
</main><script>
document.addEventListener('click',e=>{const b=e.target.closest('.modes button');if(b)b.closest('.viewer').dataset.mode=b.dataset.m});
</script></body></html>`;
  fs.writeFileSync(cfg.report, html);
  return cfg.report;
}
