// Real browser, real HTTP servers. Viewports are tiny to keep it fast.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, startServer, type Config, type RawConfig } from '../src/index.ts';
import { config, finder, freePort, html, quiet, site, tmp } from './helpers.ts';

const TALL = '<div style="height:150px"></div>';
let t: ReturnType<typeof tmp>;
let remote: Awaited<ReturnType<typeof site>>;
let local: Awaited<ReturnType<typeof site>>;
const cfg = (raw: Partial<RawConfig> = {}): Config =>
  config(t.dir, { remote: remote.url, local: { url: local.url }, pages: ['/', '/about', '/tall', '/missing'], ...raw });

before(async () => {
  t = tmp();
  remote = await site({ '/': html('white'), '/about': html('white'), '/tall': html('white') });
  local = await site({ '/': html('white'), '/about': html('red'), '/tall': html('white', TALL), '/missing': html('white') });
});
after(async () => { await remote.close(); await local.close(); t.cleanup(); });

describe('run against a remote site', () => {
  let res: Awaited<ReturnType<typeof run>>;
  let get: ReturnType<typeof finder>;
  before(async () => { res = await run(cfg(), { concurrency: 3, log: quiet }); get = finder(res); });

  it('identical pages match', () => {
    const r = get('index', 'desktop');
    assert.equal(r.status, 'match');
    assert.equal(r.diffPercentage, 0);
    assert.equal(r.failed, false);
    assert.deepEqual(r.bands, []);
  });

  it('changed pages report %, pixels and where', () => {
    const r = get('about', 'desktop');
    assert.equal(r.status, 'diff');
    assert.ok(r.diffPercentage > 60 && r.diffPercentage < 70, `got ${r.diffPercentage}`); // 200 of 300 rows
    assert.ok((r.diffCount ?? 0) > 0);
    assert.equal(r.bands.length, 1);
    assert.deepEqual([r.bands[0].y1, r.bands[0].y2], [100, 299]);
    assert.equal(r.bands[0].where[0], 'section#hero');
    assert.equal(r.failed, true);
  });

  it('flags a taller page as a size mismatch and fails it', () => {
    const r = get('tall', 'mobile');
    assert.equal(r.sizeMismatch, true);
    assert.deepEqual([r.size.remote.height, r.size.local.height], [300, 450]);
    assert.equal(r.failed, true);
  });

  it('records HTTP errors per check instead of aborting', () => {
    const r = get('missing', 'desktop');
    assert.equal(r.status, 'error');
    assert.match(r.error, /HTTP 404/);
  });

  it('summarises in task order', () => {
    assert.equal(res.ok, false);
    assert.deepEqual(res.counts, { total: 8, passed: 2, failed: 4, errors: 2 });
    assert.deepEqual(res.failed, ['about@desktop', 'about@mobile', 'tall@desktop', 'tall@mobile', 'missing@desktop', 'missing@mobile']);
    assert.deepEqual(res.results.map((r) => `${r.page}@${r.viewport}`).slice(0, 4), ['index@desktop', 'index@mobile', 'about@desktop', 'about@mobile']);
  });

  it('writes screenshots, diffs and the report', () => {
    for (const f of ['argus/desktop/about-remote.png', 'argus/desktop/about-local.png', 'argus/diffs/desktop/about.png',
      'argus/diffs/mobile/index.png', 'argus/report.html']) assert.ok(fs.existsSync(path.join(t.dir, f)), f);
    const report = t.read('argus/report.html');
    assert.match(report, /section#hero/);
    assert.match(report, /HTTP 404/);
    assert.match(report, /<b class="bad">FAIL<\/b>/);
  });

  it('uses the configured mobile viewport width', () => assert.equal(get('index', 'mobile').size.local.width, 200));
});

describe('filters and sharding', () => {
  const ids = (res: Awaited<ReturnType<typeof run>>) => res.results.map((r) => `${r.page}@${r.viewport}`);

  it('--only by name or path, --viewport', async () => {
    assert.deepEqual(ids(await run(cfg(), { only: ['about'], viewports: ['mobile'], log: quiet })), ['about@mobile']);
    assert.deepEqual(ids(await run(cfg(), { only: ['/'], viewports: ['desktop'], log: quiet })), ['index@desktop']);
  });

  it('shards split the checks without overlap', async () => {
    const c = cfg({ pages: ['/', '/about', '/tall'] });
    const a = ids(await run(c, { shard: '1/2', log: quiet }));
    const b = ids(await run(c, { shard: '2/2', log: quiet }));
    assert.equal(a.length + b.length, 6);
    assert.deepEqual(a.filter((x) => b.includes(x)), []);
  });

  it('rejects a bad shard and empty selections', async () => {
    await assert.rejects(run(cfg(), { shard: '3/2', log: quiet }), /bad shard/);
    await assert.rejects(run(cfg(), { only: ['nope'], log: quiet }), /nothing to do/);
  });

  it('a passing selection is ok', async () => {
    const res = await run(cfg(), { only: ['index'], log: quiet });
    assert.equal(res.ok, true);
    assert.deepEqual(res.failed, []);
  });
});

describe('re-diff without shooting', () => {
  it('reuses screenshots and element boxes', async () => {
    const c = cfg({ pages: ['/about'], out: 'reuse' });
    await run(c, { log: quiet });
    const res = await run(c, { shoot: false, log: quiet });
    const r = finder(res)('about', 'desktop');
    assert.equal(r.status, 'diff');
    assert.equal(r.bands[0].where[0], 'section#hero');
  });

  it('reports missing screenshots', async () => {
    const res = await run(cfg({ pages: ['/about'], out: 'empty' }), { shoot: false, log: quiet });
    assert.match(finder(res)('about', 'desktop').error, /missing screenshot.*--no-shoot/);
  });
});

describe('reference images', () => {
  let get: ReturnType<typeof finder>;
  before(async () => {
    // Use screenshots from the first run as "designs".
    const shot = (vp: string, p: string) => path.join(t.dir, `argus/${vp}/${p}-local.png`);
    fs.mkdirSync(path.join(t.dir, 'designs'), { recursive: true });
    fs.copyFileSync(shot('desktop', 'about'), path.join(t.dir, 'designs/home.png'));
    fs.copyFileSync(shot('mobile', 'about'), path.join(t.dir, 'designs/about-mobile.png'));
    fs.copyFileSync(shot('desktop', 'index'), path.join(t.dir, 'designs/tall-desktop.png'));
    fs.copyFileSync(shot('desktop', 'index'), path.join(t.dir, 'designs/tall-mobile.png'));
    t.write('designs/fake-desktop.png', 'not a png');
    const res = await run(cfg({
      out: 'img', refs: 'designs/{page}-{viewport}.png', imageThreshold: 1,
      pages: [{ path: '/', ref: { desktop: 'designs/home.png' } }, '/about', '/tall', { path: '/', name: 'fake' },
        { path: '/', name: 'gone', ref: 'designs/nope.png' }],
    }), { log: quiet });
    get = finder(res);
  });

  it('explicit ref per viewport, remote for the rest', () => {
    assert.equal(get('index', 'desktop').refType, 'image');
    assert.equal(get('index', 'desktop').remoteUrl, null);
    assert.ok(get('index', 'desktop').failed);
    assert.equal(get('index', 'mobile').refType, 'remote');
  });

  it('naming convention picks up designs/<page>-<viewport>.png', () => {
    assert.equal(get('about', 'mobile').refType, 'image');
    assert.equal(get('about', 'mobile').status, 'match');
    assert.equal(get('about', 'desktop').refType, 'remote');
  });

  it('height difference vs an image is a warning, not a failure', () => {
    const r = get('tall', 'desktop');
    assert.ok(r.sizeMismatch && !r.failed);
  });

  it('wrong width, non-PNG and missing images are clear errors', () => {
    assert.match(get('tall', 'mobile').error, /400px wide but the mobile screenshot is 200px/);
    assert.match(get('fake', 'desktop').error, /must be PNG/);
    assert.match(get('gone', 'desktop').error, /not found/);
  });

  it('the report labels image references', () => assert.match(t.read('img/report.html'), /designs\/home\.png/));

  it('works with no remote at all', async () => {
    const c = config(t.dir, { local: { url: local.url }, pages: ['/about'], out: 'noremote', refs: 'designs/{page}-{viewport}.png' });
    const get2 = finder(await run(c, { log: quiet }));
    assert.equal(get2('about', 'mobile').status, 'match');
    assert.match(get2('about', 'desktop').error, /no reference/);
  });
});

describe('high-DPI viewport', () => {
  it('scales element boxes to device pixels', async () => {
    const res = await run(cfg({ pages: ['/about'], out: 'hidpi', viewports: { retina: { width: 200, height: 300, deviceScaleFactor: 2 } } }), { log: quiet });
    const r = finder(res)('about', 'retina');
    assert.equal(r.size.local.width, 400);
    assert.deepEqual([r.bands[0].y1, r.bands[0].y2], [200, 599]);
    assert.equal(r.bands[0].where[0], 'section#hero');
  });
});

describe('concurrent runs on one output folder', () => {
  it('queue behind the lock and both finish', async () => {
    const c = cfg({ pages: ['/about'], out: 'locked' });
    const logs: string[] = [];
    const [a, b] = await Promise.all([run(c, { log: quiet }), run(c, { log: (m) => logs.push(m) })]);
    assert.equal(a.results.length, 2);
    assert.equal(b.results.length, 2);
    assert.ok(!fs.existsSync(path.join(t.dir, 'locked/.argus.lock')));
  });
});

describe('dev server', () => {
  const serverJs = (port: number) => `require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end(${JSON.stringify(html('white'))})}).listen(${port}, '127.0.0.1')`;

  it('reuses a server that is already up', async () => {
    const logs: string[] = [];
    const stop = await startServer({ url: local.url, command: 'exit 1', cwd: t.dir, timeout: 5000, logFile: path.join(t.dir, 's.log'), log: (m) => logs.push(m) });
    stop();
    assert.match(logs[0], /using running server/);
  });

  it('starts the command, waits for it, and stops it', async () => {
    const port = await freePort();
    t.write('srv.cjs', serverJs(port));
    const stop = await startServer({ url: `http://127.0.0.1:${port}`, command: 'node srv.cjs', cwd: t.dir, timeout: 15000, logFile: path.join(t.dir, 'srv.log'), log: quiet });
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
    stop();
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  });

  it('fails fast when the command exits', async () => {
    const port = await freePort();
    await assert.rejects(
      startServer({ url: `http://127.0.0.1:${port}`, command: 'node -e "process.exit(3)"', cwd: t.dir, timeout: 15000, logFile: path.join(t.dir, 'x.log'), log: quiet }),
      /exited \(3\)/,
    );
  });

  it('times out when the URL never comes up', async () => {
    const port = await freePort();
    await assert.rejects(
      startServer({ url: `http://127.0.0.1:${port}`, command: 'node -e "setTimeout(()=>{},60000)"', cwd: t.dir, timeout: 1500, logFile: path.join(t.dir, 'y.log'), log: quiet }),
      /timed out/,
    );
  });

  it('errors when nothing is up and no command is set', async () => {
    const port = await freePort();
    await assert.rejects(
      startServer({ url: `http://127.0.0.1:${port}`, command: null, cwd: t.dir, timeout: 1000, logFile: path.join(t.dir, 'z.log'), log: quiet }),
      /local\.command is not set/,
    );
  });

  it('run() starts local.command and stops it afterwards', async () => {
    const port = await freePort();
    t.write('dev.cjs', serverJs(port));
    const c = config(t.dir, { remote: remote.url, local: { url: `http://127.0.0.1:${port}`, command: 'node dev.cjs' }, pages: ['/'], out: 'dev' });
    const res = await run(c, { log: quiet });
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(path.join(t.dir, 'dev/server.log')));
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  });
});
