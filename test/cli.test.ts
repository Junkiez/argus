// Runs the real CLI as a child process.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, site, tmp, VIEWPORTS } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function argus(cwd: string, ...args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, CI: '1' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

let t: ReturnType<typeof tmp>;
let remote: Awaited<ReturnType<typeof site>>;
let local: Awaited<ReturnType<typeof site>>;

before(async () => {
  t = tmp();
  remote = await site({ '/': html('white'), '/about': html('white') });
  local = await site({ '/': html('white'), '/about': html('red') });
  t.write('argus.config.json', JSON.stringify({ remote: remote.url, local: { url: local.url }, pages: ['/', '/about'], viewports: VIEWPORTS }));
});
after(async () => { await remote.close(); await local.close(); t.cleanup(); });

describe('cli: info', () => {
  it('-v prints the package version', async () => {
    const r = await argus(t.dir, '-v');
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
  });

  it('-h prints usage', async () => {
    const r = await argus(t.dir, '-h');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /argus init/);
    assert.match(r.stdout, /Exit codes/);
  });

  it('unknown command exits 2', async () => {
    const r = await argus(t.dir, 'deploy');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command "deploy"/);
  });

  it('unknown flag exits non-zero', async () => {
    const r = await argus(t.dir, '--nope');
    assert.notEqual(r.code, 0);
  });
});

describe('cli: run', () => {
  it('--json: exit 1 with failed checks, machine-readable stdout only', async () => {
    const r = await argus(t.dir, '--json');
    assert.equal(r.code, 1);
    assert.equal(r.stderr, '');
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, false);
    assert.deepEqual(res.failed, ['about@desktop', 'about@mobile']);
    assert.ok(path.isAbsolute(res.report) && fs.existsSync(res.report));
    assert.equal(res.results[2].bands[0].where[0], 'section#hero');
  });

  it('exit 0 when everything matches; --only and --viewport filter', async () => {
    const r = await argus(t.dir, '--json', '-p', '/', '--viewport', 'mobile');
    assert.equal(r.code, 0);
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, true);
    assert.deepEqual(res.results.map((x: { page: string; viewport: string }) => `${x.page}@${x.viewport}`), ['index@mobile']);
  });

  it('human output: progress on stderr, table + report path on stdout', async () => {
    const r = await argus(t.dir, '-p', 'about', '--viewport', 'desktop');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /about @ desktop/);
    assert.match(r.stdout, /about\s+desktop\s+\d+\.\d+%\s+section#hero/);
    assert.match(r.stdout, /FAILED: about@desktop/);
    assert.match(r.stdout, /Report: .*report\.html/);
  });

  it('--no-shoot re-diffs existing screenshots', async () => {
    const r = await argus(t.dir, '--json', '--no-shoot', '-p', 'about', '--viewport', 'desktop');
    assert.equal(JSON.parse(r.stdout).results[0].status, 'diff');
  });

  // Runs after --no-shoot: it overwrites the about@desktop screenshots.
  it('--remote overrides the config', async () => {
    const r = await argus(t.dir, '--json', '-p', 'about', '--viewport', 'desktop', '--remote', local.url);
    assert.equal(JSON.parse(r.stdout).ok, true);
  });

  it('-c picks another config; a bad config exits 2 with a JSON error', async () => {
    t.write('bad.json', JSON.stringify({ local: { url: local.url }, pages: ['/'] }));
    const r = await argus(t.dir, '--json', '-c', 'bad.json');
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout).error, /remote/);
  });

  it('a bad shard exits 2', async () => {
    const r = await argus(t.dir, '--shard', '0/2');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bad shard/);
  });
});

describe('cli: init', () => {
  it('init --json writes a config', async () => {
    const d = tmp();
    try {
      d.write('package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }));
      const r = await argus(d.dir, 'init', '--json', '--remote', 'https://ref.dev');
      assert.equal(r.code, 0);
      const res = JSON.parse(r.stdout);
      assert.equal(res.created, true);
      assert.equal(res.config.local.url, 'http://localhost:5173');
      assert.equal(JSON.parse(d.read('package.json')).scripts.argus, 'argus');
    } finally { d.cleanup(); }
  });

  it('running without a config inits first, then stops if no remote is known', async () => {
    const d = tmp();
    try {
      const r = await argus(d.dir, '-y');
      assert.equal(r.code, 2);
      assert.match(r.stderr, /no argus\.config\.json found, running init/);
      assert.match(r.stderr, /set "remote"/);
      assert.ok(fs.existsSync(path.join(d.dir, 'argus.config.json')));
    } finally { d.cleanup(); }
  });

  it('running without a config but with --remote inits and runs', async () => {
    const d = tmp();
    try {
      d.write('index.html', '');
      // Static site detection proposes `npx serve`; point local at our fixture instead.
      await argus(d.dir, 'init', '-y', '--remote', remote.url);
      const cfg = JSON.parse(d.read('argus.config.json'));
      cfg.local = { url: local.url };
      cfg.viewports = { desktop: VIEWPORTS.desktop };
      d.write('argus.config.json', JSON.stringify(cfg));
      const r = await argus(d.dir, '--json');
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout).results[0].status, 'match');
    } finally { d.cleanup(); }
  });
});
