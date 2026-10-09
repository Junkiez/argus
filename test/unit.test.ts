import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULTS, autoConcurrency, isFailed, loadConfig, normalizeConfig, pageName, refImage, resolvePages, toBands,
  type RawConfig, type Result,
} from '../src/index.ts';
import { fmtPct, writeReport } from '../src/report.ts';
import { config, tmp } from './helpers.ts';

describe('pageName', () => {
  for (const [input, want] of [
    ['/', 'index'], ['', 'index'], ['/about', 'about'], ['/about/', 'about'], ['/blog/post-1', 'blog-post-1'],
    ['/about.html', 'about'], ['/docs/a b?c', 'docs-a-b-c'], ['/v1.2/x', 'v1.2-x'],
  ]) {
    it(`${JSON.stringify(input)} → ${want}`, () => assert.equal(pageName(input), want));
  }
});

describe('normalizeConfig', () => {
  const base: RawConfig = { remote: 'https://x.dev', local: { url: 'http://localhost:3000' }, pages: ['/'] };

  it('fills defaults and resolves paths against the root', () => {
    const c = normalizeConfig(base, '/proj');
    assert.equal(c.threshold, DEFAULTS.threshold);
    assert.deepEqual(Object.keys(c.viewports), ['desktop', 'tablet', 'mobile']);
    assert.equal(c.out, path.resolve('/proj/argus'));
    assert.equal(c.diffDir, path.resolve('/proj/argus/diffs'));
    assert.equal(c.report, path.resolve('/proj/argus/report.html'));
    assert.equal(c.root, '/proj');
  });

  it('keeps custom out, diffDir and report', () => {
    const c = normalizeConfig({ ...base, out: 'shots', diffDir: 'd', report: 'r/index.html' }, '/proj');
    assert.equal(c.out, path.resolve('/proj/shots'));
    assert.equal(c.diffDir, path.resolve('/proj/d'));
    assert.equal(c.report, path.resolve('/proj/r/index.html'));
  });

  it('derives diffDir and report from a custom out', () => {
    const c = normalizeConfig({ ...base, out: 'shots' }, '/proj');
    assert.equal(c.diffDir, path.resolve('/proj/shots/diffs'));
  });

  it('requires some reference', () => {
    assert.throws(() => normalizeConfig({ ...base, remote: undefined }), /remote/);
    assert.doesNotThrow(() => normalizeConfig({ ...base, remote: undefined, refs: 'd/{page}.png' }));
    assert.doesNotThrow(() => normalizeConfig({ ...base, remote: undefined, pages: [{ path: '/', ref: 'a.png' }] }));
  });

  it('requires local.url and pages', () => {
    assert.throws(() => normalizeConfig({ ...base, local: {} as RawConfig['local'] }), /local\.url/);
    assert.throws(() => normalizeConfig({ ...base, pages: [] }), /pages/);
  });
});

describe('loadConfig', () => {
  it('reads JSON and resolves paths relative to the config file, not cwd', () => {
    const t = tmp();
    try {
      t.write('sub/argus.config.json', JSON.stringify({ remote: 'https://x.dev', local: { url: 'http://l' }, pages: ['/'] }));
      const c = loadConfig(path.join(t.dir, 'sub/argus.config.json'));
      assert.equal(c.out, path.join(t.dir, 'sub/argus'));
    } finally { t.cleanup(); }
  });

  it('throws on invalid JSON', () => {
    const t = tmp();
    try {
      t.write('bad.json', '{ nope');
      assert.throws(() => loadConfig(path.join(t.dir, 'bad.json')), SyntaxError);
    } finally { t.cleanup(); }
  });
});

describe('resolvePages', () => {
  const cfg = (pages: RawConfig['pages'], remote: string | null = 'https://ref.dev/') =>
    config('/p', { remote: remote ?? undefined, local: { url: 'http://localhost:4321/' }, pages, refs: remote ? undefined : 'x' });

  it('joins paths onto both base URLs without double slashes', () => {
    const [p] = resolvePages(cfg(['/about']));
    assert.deepEqual(p, { name: 'about', path: '/about', ref: null, remoteUrl: 'https://ref.dev/about', localUrl: 'http://localhost:4321/about' });
  });

  it('accepts paths without a leading slash', () => {
    assert.equal(resolvePages(cfg(['faq']))[0].localUrl, 'http://localhost:4321/faq');
  });

  it('supports per-site relative paths and full URLs', () => {
    const [a, b] = resolvePages(cfg([
      { path: '/pricing', local: '/pricing.html' },
      { name: 'home', remote: 'https://other.dev/', local: 'http://127.0.0.1:9/' },
    ]));
    assert.equal(a.remoteUrl, 'https://ref.dev/pricing');
    assert.equal(a.localUrl, 'http://localhost:4321/pricing.html');
    assert.equal(b.name, 'home');
    assert.equal(b.remoteUrl, 'https://other.dev/');
    assert.equal(b.localUrl, 'http://127.0.0.1:9/');
  });

  it('has no remote URL when no remote is configured', () => {
    assert.equal(resolvePages(cfg(['/'], null))[0].remoteUrl, null);
  });

  it('keeps ref specs', () => {
    assert.deepEqual(resolvePages(cfg([{ path: '/', ref: { mobile: 'm.png' } }]))[0].ref, { mobile: 'm.png' });
  });

  it('rejects a page with nothing to load', () => {
    assert.throws(() => resolvePages(cfg([{ name: 'x' }])), /needs "path"/);
  });
});

describe('toBands', () => {
  const boxes = [
    { label: 'header#top', top: 0, bottom: 100 },
    { label: 'section#hero', top: 100, bottom: 300 },
    { label: 'h2 "Hero"', top: 100, bottom: 120 },
    { label: 'main', top: 0, bottom: 1000 },
  ];

  it('returns nothing for no changed rows', () => assert.deepEqual(toBands([], boxes), []));

  it('merges rows closer than the gap and splits farther ones', () => {
    const b = toBands([10, 11, 20, 100, 101], boxes, 16);
    assert.deepEqual(b.map((x) => [x.y1, x.y2, x.rows, x.height]), [[10, 20, 3, 11], [100, 101, 2, 2]]);
  });

  it('prefers the smallest element that fully covers the band', () => {
    assert.deepEqual(toBands([150, 160], boxes)[0].where, ['section#hero', 'main']);
    assert.equal(toBands([105, 110], boxes)[0].where[0], 'h2 "Hero"');
  });

  it('falls back to partially overlapping elements', () => {
    const where = toBands([90, 95, 105], boxes, 16)[0].where; // straddles header and hero
    assert.equal(where[0], 'main');
    assert.ok(where.includes('header#top') || where.includes('section#hero'));
  });

  it('lists at most three elements', () => assert.ok(toBands([105], boxes)[0].where.length <= 3));

  it('keeps the biggest bands, in page order, when over the limit', () => {
    const lines = [0, 100, 101, 102, 200, 300, 301];
    const b = toBands(lines, [], 5, 2);
    assert.deepEqual(b.map((x) => x.y1), [100, 300]);
  });
});

describe('refImage', () => {
  it('uses an explicit ref for all viewports or per viewport', () => {
    assert.equal(refImage({ name: 'a', ref: 'd/a.png' }, 'mobile', { root: '/r' }), path.resolve('/r/d/a.png'));
    assert.equal(refImage({ name: 'a', ref: { mobile: 'm.png' } }, 'mobile', { root: '/r' }), path.resolve('/r/m.png'));
    assert.equal(refImage({ name: 'a', ref: { mobile: 'm.png' } }, 'desktop', { root: '/r' }), null);
  });

  it('uses the refs pattern only when the file exists', () => {
    const t = tmp();
    try {
      t.write('designs/about-mobile.png', 'x');
      const cfg = { root: t.dir, refs: 'designs/{page}-{viewport}.png' };
      assert.equal(refImage({ name: 'about', ref: null }, 'mobile', cfg), path.join(t.dir, 'designs/about-mobile.png'));
      assert.equal(refImage({ name: 'about', ref: null }, 'desktop', cfg), null);
    } finally { t.cleanup(); }
  });

  it('explicit ref wins over the pattern', () => {
    assert.equal(refImage({ name: 'a', ref: 'x.png' }, 'mobile', { root: '/r', refs: '{page}.png' }), path.resolve('/r/x.png'));
  });
});

describe('isFailed', () => {
  const r = (o: Partial<Result>): Result => ({
    page: 'p', path: '/', viewport: 'd', refType: 'remote', remoteUrl: null, localUrl: '', remote: '', local: '', diff: '',
    status: 'diff', diffPercentage: 0, sizeMismatch: false, ...o,
  });
  const cfg = { threshold: 0.1 };

  it('errors always fail', () => assert.ok(isFailed(r({ status: 'error' }), cfg)));
  it('passes at or under the threshold', () => assert.ok(!isFailed(r({ diffPercentage: 0.1 }), cfg)));
  it('fails over the threshold', () => assert.ok(isFailed(r({ diffPercentage: 0.11 }), cfg)));
  it('fails on a size change against a remote site', () => assert.ok(isFailed(r({ sizeMismatch: true }), cfg)));
  it('only warns on a size change against an image', () => assert.ok(!isFailed(r({ sizeMismatch: true, refType: 'image' }), cfg)));
  it('uses imageThreshold for images', () => {
    const c = { threshold: 0.1, imageThreshold: 2 };
    assert.ok(!isFailed(r({ refType: 'image', diffPercentage: 1.5 }), c));
    assert.ok(isFailed(r({ refType: 'remote', diffPercentage: 1.5 }), c));
  });
});

describe('autoConcurrency', () => {
  it('returns a positive integer', () => {
    const n = autoConcurrency();
    assert.ok(Number.isInteger(n) && n >= 1);
  });
});

describe('fmtPct', () => {
  it('uses 3 decimals under 1%, 2 above', () => {
    assert.equal(fmtPct(0), '0.000%');
    assert.equal(fmtPct(0.1004), '0.100%');
    assert.equal(fmtPct(12.345), '12.35%');
  });
});

describe('writeReport', () => {
  it('writes self-contained HTML, escapes user content and links images relatively', () => {
    const t = tmp();
    try {
      const cfg = config(t.dir, { remote: 'https://ref.dev', report: 'out/report.html' });
      const res: Result[] = [
        { page: '<script>x</script>', path: '/', viewport: 'desktop', refType: 'remote', remoteUrl: 'https://ref.dev/', localUrl: 'http://l/',
          remote: path.join(t.dir, 'argus/desktop/a-remote.png'), local: path.join(t.dir, 'argus/desktop/a-local.png'), diff: path.join(t.dir, 'argus/diffs/a.png'),
          status: 'diff', diffPercentage: 5, diffCount: 10, sizeMismatch: true, failed: true,
          size: { remote: { width: 400, height: 300 }, local: { width: 400, height: 350 } },
          bands: [{ y1: 10, y2: 20, rows: 11, height: 11, where: ['section#"hero"'] }] },
        { page: 'b', path: '/b', viewport: 'desktop', refType: 'image', remoteUrl: null, localUrl: 'http://l/b',
          remote: path.join(t.dir, 'designs/b.png'), local: '', diff: '', status: 'error', error: 'boom & bust', failed: true },
      ];
      const file = writeReport({ ok: false, threshold: 0.1, shard: null, report: cfg.report, failed: [], results: res,
        counts: { total: 2, passed: 0, failed: 1, errors: 1 } }, cfg);
      const out = fs.readFileSync(file, 'utf8');
      assert.equal(file, path.join(t.dir, 'out/report.html'));
      assert.ok(!out.includes('<script>x</script>'));
      assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/);
      assert.match(out, /section#&quot;hero&quot;/);
      assert.match(out, /boom &amp; bust/);
      assert.match(out, /src="\.\.\/argus\/diffs\/a\.png"/);
      assert.match(out, /height \+50px locally/);
      assert.match(out, /<b class="bad">FAIL<\/b>/);
      assert.match(out, /image <code>\.\.\/designs\/b\.png<\/code>/);
      assert.doesNotMatch(out, /<script src=|<link /, 'no external assets');
    } finally { t.cleanup(); }
  });
});
