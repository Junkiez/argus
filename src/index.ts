import { chromium, type Browser, type BrowserContext, type Page as Tab } from 'playwright';
import { compare } from 'odiff-bin';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { writeReport } from './report.ts';
import type { Band, Box, Config, Log, Page, RawConfig, Result, RunOptions, Size, Summary, Viewport } from './types.ts';

export type * from './types.ts';

export const CONFIG_FILE = 'argus.config.json';

export const DEFAULTS = {
  out: 'argus',
  threshold: 0.1,
  viewports: {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 768, height: 1024, isMobile: true },
    mobile: { width: 390, height: 844, isMobile: true },
  } as Record<string, Viewport>,
  css: '.reveal{opacity:1!important;transform:none!important;transition:none!important}',
  settle: 300,
  serverTimeout: 120000,
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isMissingBrowser = (e: unknown) => /Executable doesn't exist/.test(errMsg(e));

// Launches Chromium, downloading it first if it isn't installed yet, so
// `npx argus` works without a separate `playwright install` step.
export async function launchBrowser(log: Log): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (e) {
    if (!isMissingBrowser(e)) throw e;
    log('Chromium is not installed yet, downloading it (one time, ~100 MB)...');
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright')), 'cli.js');
    // Output goes to stderr so --json stdout stays clean.
    execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 2, 2] });
    return chromium.launch();
  }
}

// Fills defaults and resolves file paths relative to the config file.
export function loadConfig(file = CONFIG_FILE): Config {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawConfig;
  return normalizeConfig(raw, path.dirname(path.resolve(file)));
}

export function normalizeConfig(raw: RawConfig, root = process.cwd()): Config {
  const merged = { ...DEFAULTS, ...raw, root };
  if (!merged.remote && !merged.refs && !merged.pages?.some((p) => typeof p !== 'string' && p.ref)) {
    throw new Error('config: set "remote" (reference site URL), "refs" (reference image pattern) or per-page "ref"');
  }
  if (!merged.local?.url) throw new Error('config: "local.url" is required');
  if (!merged.pages?.length) throw new Error('config: "pages" is empty');
  const out = path.resolve(root, merged.out);
  return {
    ...merged,
    out,
    diffDir: path.resolve(root, raw.diffDir ?? path.join(out, 'diffs')),
    report: path.resolve(root, raw.report ?? path.join(out, 'report.html')),
  };
}

export function pageName(p: string): string {
  const slug = p.replace(/\.html?$/, '').replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-');
  return slug || 'index';
}

const join = (base: string, p: string) => base.replace(/\/+$/, '') + (p.startsWith('/') ? p : `/${p}`);

// Pages are paths ("/about") or { path, remote, local, name, ref } when the
// two sites use different URLs, or the reference is an image instead of a site.
export function resolvePages(cfg: Config): Page[] {
  return cfg.pages.map((spec) => {
    const p = typeof spec === 'string' ? { path: spec } : spec;
    const any = p.path ?? p.local ?? p.remote;
    if (!any) throw new Error(`config: page needs "path", "local" or "remote": ${JSON.stringify(spec)}`);
    const remotePath = p.remote ?? p.path;
    return {
      name: p.name ?? pageName(any),
      path: p.path ?? null,
      ref: p.ref ?? null,
      remoteUrl: p.remote?.includes('://') ? p.remote : cfg.remote && remotePath ? join(cfg.remote, remotePath) : null,
      localUrl: p.local?.includes('://') ? p.local : join(cfg.local.url, p.local ?? p.path ?? '/'),
    };
  });
}

const readNum = (file: string, fn: (s: string) => number) => {
  try { return fn(fs.readFileSync(file, 'utf8').trim()); } catch { return NaN; }
};

// Container-aware limits: cgroup v2 quotas when present, host values otherwise.
export function autoConcurrency(): number {
  const cpuQuota = readNum('/sys/fs/cgroup/cpu.max', (s) => {
    const [q, p] = s.split(' ');
    return q === 'max' ? NaN : Number(q) / Number(p);
  });
  const cpus = Number.isFinite(cpuQuota) ? Math.max(1, Math.floor(cpuQuota)) : os.availableParallelism();
  const memMax = readNum('/sys/fs/cgroup/memory.max', Number);
  const mem = Number.isFinite(memMax) ? memMax : os.totalmem();
  // ponytail: ~300MB browser base + ~400MB per full-page tab; measure if tabs OOM.
  const byMem = Math.floor((mem / 2 ** 20 - 300) / 400);
  return Math.max(1, Math.min(cpus, byMem));
}

// Cross-instance lock on the output dir (mkdir is atomic, also on NFS/shared
// volumes). Other instances queue until it's released or goes stale.
async function acquireLock(dir: string, { staleMs = 120_000, log }: { staleMs?: number; log: Log }) {
  const lock = path.join(dir, '.argus.lock');
  for (let waited = false; ; ) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), `${os.hostname()} pid ${process.pid} ${new Date().toISOString()}`);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; } // released meanwhile
      if (age > staleMs) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (!waited) { log(`queued: ${dir} is locked by another instance`); waited = true; }
      await sleep(1000);
    }
  }
  const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} }, staleMs / 4);
  beat.unref();
  const release = () => { clearInterval(beat); fs.rmSync(lock, { recursive: true, force: true }); };
  const onSignal = () => { release(); process.exit(130); };
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal);
  return () => { process.off('SIGINT', onSignal).off('SIGTERM', onSignal); release(); };
}

async function isUp(url: string) {
  try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

export interface ServerOptions {
  url: string;
  command?: string | null;
  cwd: string;
  timeout: number;
  logFile: string;
  log: Log;
}

// Reuses a server already listening on local.url, otherwise runs
// local.command and waits for the URL. Returns a stop function.
export async function startServer({ url, command, cwd, timeout, logFile, log }: ServerOptions): Promise<() => void> {
  if (await isUp(url)) { log(`using running server at ${url}`); return () => {}; }
  if (!command) throw new Error(`${url} is not reachable and local.command is not set`);
  log(`starting "${command}" (output: ${logFile})`);
  const fd = fs.openSync(logFile, 'w');
  const win = process.platform === 'win32';
  const child = spawn(command, {
    shell: true, cwd, detached: !win, stdio: ['ignore', fd, fd],
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
  });
  let exited: number | string | null = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  const stop = () => {
    if (exited !== null || child.pid === undefined) return;
    try {
      if (win) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM'); // whole group: npm → node → vite
    } catch {}
  };
  process.once('exit', stop);
  const deadline = Date.now() + timeout;
  while (!(await isUp(url))) {
    if (exited !== null) throw new Error(`"${command}" exited (${exited}) before ${url} came up, see ${logFile}`);
    if (Date.now() > deadline) { stop(); throw new Error(`timed out waiting for ${url}, see ${logFile}`); }
    await sleep(500);
  }
  log(`server up at ${url}`);
  return stop;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Runs in the browser. Boxes of landmark elements, used to say *where* on
// the page a diff is.
function collectBoxes(): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll('header,nav,main,section,article,aside,footer,form,[id],h1,h2,h3')) {
    const r = el.getBoundingClientRect();
    if (r.height < 8 || r.width < 8) continue;
    let label = el.tagName.toLowerCase();
    if (el.id) label += `#${el.id}`;
    else if (typeof el.className === 'string' && el.className.trim()) label += `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`;
    if (/^H\d$/.test(el.tagName)) label += ` "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
    out.push({ label, top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY) });
    if (out.length >= 800) break;
  }
  return out;
}

async function shoot(tab: Tab, url: string, outPath: string, cfg: Config): Promise<Box[]> {
  const res = await tab.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  if (res && res.status() >= 400) throw new Error(`${url} returned HTTP ${res.status()}`);
  // Scroll through so IntersectionObserver-driven animations fire.
  const vh = tab.viewportSize()?.height ?? 900;
  const h = await tab.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += vh) {
    await tab.evaluate((pos) => window.scrollTo(0, pos), y);
    await tab.waitForTimeout(150);
  }
  await tab.evaluate(() => window.scrollTo(0, 0));
  if (cfg.css) await tab.addStyleTag({ content: cfg.css });
  await tab.waitForTimeout(cfg.settle);
  await tab.screenshot({ path: outPath, fullPage: true, animations: 'disabled' });
  return tab.evaluate(collectBoxes);
}

function readHead(file: string, n: number) {
  const b = Buffer.alloc(n);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, n, 0); } finally { fs.closeSync(fd); }
  return b;
}

function pngSize(file: string): Size {
  const b = readHead(file, 24);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const isPng = (f: string) => readHead(f, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// Merges changed rows into vertical bands and labels each with the
// smallest page elements that cover it.
export function toBands(lines: number[], boxes: Box[], gap = 16, max = 30): Band[] {
  const bands: Omit<Band, 'height' | 'where'>[] = [];
  for (const y of lines) {
    const last = bands.at(-1);
    if (last && y - last.y2 <= gap) { last.y2 = y; last.rows++; } else bands.push({ y1: y, y2: y, rows: 1 });
  }
  const top = bands.length > max ? [...bands].sort((a, b) => b.rows - a.rows).slice(0, max).sort((a, b) => a.y1 - b.y1) : bands;
  return top.map((b) => {
    const where = boxes
      .filter((x) => x.top <= b.y2 && x.bottom >= b.y1)
      .map((x) => ({ label: x.label, covers: x.top <= b.y1 && x.bottom >= b.y2, h: x.bottom - x.top }))
      .sort((p, q) => (Number(q.covers) - Number(p.covers)) || (p.h - q.h))
      .slice(0, 3)
      .map((x) => x.label);
    return { ...b, height: b.y2 - b.y1 + 1, where };
  });
}

// Element boxes are CSS px; screenshots are device px.
const scaleBoxes = (boxes: Box[], k: number) => (k === 1 ? boxes : boxes.map((b) => ({ ...b, top: b.top * k, bottom: b.bottom * k })));

// Reference image for a page × viewport: page.ref ("x.png" for all viewports
// or { mobile: "x.png" }), else the cfg.refs pattern if that file exists.
export function refImage(page: Pick<Page, 'name' | 'ref'>, vp: string, cfg: Pick<Config, 'root' | 'refs'>): string | null {
  const explicit = typeof page.ref === 'string' ? page.ref : page.ref?.[vp];
  if (explicit) return path.resolve(cfg.root, explicit);
  if (!cfg.refs) return null;
  const f = path.resolve(cfg.root, cfg.refs.replaceAll('{page}', page.name).replaceAll('{viewport}', vp));
  return fs.existsSync(f) ? f : null;
}

interface Task { page: Page; vp: string; size: Viewport }

async function runTask({ page, vp, size: vpSize, ctx, cfg }: Task & { ctx?: BrowserContext; cfg: Config }): Promise<Result> {
  const shotDir = path.join(cfg.out, vp);
  const diffDir = path.join(cfg.diffDir, vp);
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(diffDir, { recursive: true });
  const image = refImage(page, vp, cfg);
  const remote = image ?? path.join(shotDir, `${page.name}-remote.png`);
  const local = path.join(shotDir, `${page.name}-local.png`);
  const diff = path.join(diffDir, `${page.name}.png`);
  const boxesFile = `${local}.boxes.json`;
  const base = {
    page: page.name, path: page.path, viewport: vp, refType: image ? 'image' : 'remote',
    remoteUrl: image ? null : page.remoteUrl, localUrl: page.localUrl, remote, local, diff,
  } as const;
  try {
    if (image) {
      if (!fs.existsSync(image)) throw new Error(`reference image not found: ${image}`);
      if (!isPng(image)) throw new Error(`reference image must be PNG: ${image}`);
    } else if (!page.remoteUrl) {
      throw new Error(`no reference: set "remote", or add a ref image for ${page.name} @ ${vp}`);
    }
    let boxes: Box[];
    if (ctx) {
      const tab = await ctx.newPage();
      try {
        if (!image) await shoot(tab, page.remoteUrl!, remote, cfg);
        boxes = await shoot(tab, page.localUrl, local, cfg);
        fs.writeFileSync(boxesFile, JSON.stringify(boxes));
      } finally {
        await tab.close();
      }
    } else {
      try { boxes = JSON.parse(fs.readFileSync(boxesFile, 'utf8')); } catch { boxes = []; }
    }
    const r = await compare(remote, local, diff, { antialiasing: true, captureDiffLines: true, failOnLayoutDiff: false, noFailOnFsErrors: true });
    if (!r.match && r.reason === 'file-not-exists') throw new Error(`missing screenshot ${r.file} (run without --no-shoot)`);
    const size = { remote: pngSize(remote), local: pngSize(local) };
    if (image && size.remote.width !== size.local.width) {
      throw new Error(`reference image is ${size.remote.width}px wide but the ${vp} screenshot is ${size.local.width}px; `
        + 'match the viewport width (× deviceScaleFactor) to the design');
    }
    // odiff only compares the overlapping area, so a height change has to be flagged on its own.
    const sizeMismatch = size.remote.width !== size.local.width || size.remote.height !== size.local.height;
    if (r.match) {
      fs.copyFileSync(local, diff); // odiff writes nothing on exact match
      return { ...base, status: sizeMismatch ? 'diff' : 'match', diffPercentage: 0, diffCount: 0, size, sizeMismatch, bands: [] };
    }
    if (r.reason === 'layout-diff') return { ...base, status: 'diff', diffPercentage: 100, diffCount: null, size, sizeMismatch: true, bands: [] };
    if (r.reason !== 'pixel-diff') throw new Error(`unexpected odiff result: ${JSON.stringify(r)}`);
    const bands = toBands(r.diffLines ?? [], scaleBoxes(boxes, vpSize.deviceScaleFactor ?? 1));
    return { ...base, status: 'diff', diffPercentage: r.diffPercentage, diffCount: r.diffCount, size, sizeMismatch, bands };
  } catch (e) {
    return { ...base, status: 'error', error: errMsg(e).split('\n')[0] };
  }
}

// Design images are rarely drawn at the real page height, so for them a height
// difference is only a warning; they can also get a looser threshold.
export function isFailed(r: Result, cfg: Pick<Config, 'threshold' | 'imageThreshold'>): boolean {
  if (r.status === 'error') return true;
  const image = r.refType === 'image';
  if (r.sizeMismatch && !image) return true;
  return (r.diffPercentage ?? 0) > (image ? cfg.imageThreshold ?? cfg.threshold : cfg.threshold);
}

export async function run(cfg: Config, opts: RunOptions = {}): Promise<Summary> {
  const { log = () => {}, shoot: doShoot = true, server = true, only, viewports, concurrency, shard, browserWs } = opts;
  fs.mkdirSync(cfg.out, { recursive: true });
  let pages = resolvePages(cfg);
  if (only?.length) pages = pages.filter((p) => only.includes(p.name) || (p.path !== null && only.includes(p.path)));
  let vps = Object.entries(cfg.viewports);
  if (viewports?.length) vps = vps.filter(([name]) => viewports.includes(name));
  let tasks: Task[] = pages.flatMap((page) => vps.map(([vp, size]) => ({ page, vp, size })));
  if (shard) {
    const [k, n] = shard.split('/').map(Number);
    if (!(k >= 1 && k <= n)) throw new Error(`bad shard "${shard}", expected k/n`);
    tasks = tasks.filter((_, i) => i % n === k - 1);
  }
  if (!tasks.length) throw new Error('nothing to do: no pages/viewports match the filters');
  const n = concurrency ?? cfg.concurrency ?? autoConcurrency();
  log(`${pages.length} pages × ${vps.length} viewports, concurrency ${n}${shard ? `, shard ${shard}` : ''}`);

  const release = await acquireLock(cfg.out, { log });
  const results: Result[] = [];
  let stopServer = () => {};
  try {
    if (doShoot && server) {
      stopServer = await startServer({
        url: cfg.local.url, command: cfg.local.command, cwd: cfg.root,
        timeout: cfg.serverTimeout, logFile: path.join(cfg.out, 'server.log'), log,
      });
    }
    let browser: Browser | undefined;
    if (doShoot) browser = browserWs ? await chromium.connect(browserWs) : await launchBrowser(log);
    try {
      const ctxs = new Map<string, BrowserContext>();
      if (browser) {
        for (const [vp, s] of vps) {
          ctxs.set(vp, await browser.newContext({
            viewport: { width: s.width, height: s.height },
            deviceScaleFactor: s.deviceScaleFactor ?? 1,
            isMobile: !!s.isMobile,
            hasTouch: !!s.isMobile,
            ...(s.userAgent && { userAgent: s.userAgent }),
          }));
        }
      }
      await pool(tasks, n, async (t) => {
        log(`${t.page.name} @ ${t.vp}`);
        results.push(await runTask({ ...t, ctx: ctxs.get(t.vp), cfg }));
      });
    } finally {
      if (browser) await browser.close();
    }
  } finally {
    stopServer();
    release();
  }

  const order = new Map(tasks.map((t, i) => [`${t.page.name}@${t.vp}`, i]));
  const key = (r: Result) => order.get(`${r.page}@${r.viewport}`) ?? 0;
  results.sort((a, b) => key(a) - key(b));
  for (const r of results) r.failed = isFailed(r, cfg);
  const failedResults = results.filter((r) => r.failed);
  const summary: Summary = {
    ok: failedResults.length === 0,
    threshold: cfg.threshold,
    shard: shard ?? null,
    report: cfg.report,
    counts: {
      total: results.length,
      passed: results.length - failedResults.length,
      failed: failedResults.filter((r) => r.status !== 'error').length,
      errors: results.filter((r) => r.status === 'error').length,
    },
    failed: failedResults.map((r) => `${r.page}@${r.viewport}`),
    results,
  };
  writeReport(summary, cfg);
  return summary;
}
