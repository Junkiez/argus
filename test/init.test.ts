import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detect, init } from '../src/init.ts';
import { quiet, tmp } from './helpers.ts';

let t: ReturnType<typeof tmp>;
beforeEach(() => { t = tmp(); });
afterEach(() => t.cleanup());

const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { dev: 'x' }, extra = {}) =>
  t.write('package.json', JSON.stringify({ name: 'app', scripts, devDependencies: deps, ...extra }, null, 2));
const files = (...fs: string[]) => fs.forEach((f) => t.write(f, ''));

describe('detect: frameworks and routes', () => {
  it('Next.js app router: route groups dropped, dynamic/private/api skipped', () => {
    pkg({ next: '15' });
    files('app/page.tsx', 'app/about/page.tsx', 'app/(marketing)/pricing/page.tsx', 'app/blog/[slug]/page.tsx',
      'app/_lib/page.tsx', 'app/@modal/page.tsx', 'app/api/hello/page.ts', 'app/layout.tsx');
    const d = detect(t.dir);
    assert.equal(d.framework, 'Next.js');
    assert.equal(d.local.url, 'http://localhost:3000');
    assert.deepEqual(d.pages, ['/', '/about', '/pricing']);
  });

  it('Next.js pages router, also under src/', () => {
    pkg({ next: '14' });
    files('src/pages/index.tsx', 'src/pages/contact.jsx', 'src/pages/_app.tsx', 'src/pages/_document.tsx', 'src/pages/api/x.ts', 'src/pages/docs/index.mdx');
    assert.deepEqual(detect(t.dir).pages, ['/', '/contact', '/docs']);
  });

  it('Astro', () => {
    pkg({ astro: '5' });
    files('src/pages/index.astro', 'src/pages/about.md', 'src/pages/blog/index.astro', 'src/pages/blog/[slug].astro', 'src/pages/_draft.astro');
    const d = detect(t.dir);
    assert.equal(d.framework, 'Astro');
    assert.equal(d.local.url, 'http://localhost:4321');
    assert.deepEqual(d.pages, ['/', '/about', '/blog']);
  });

  it('Nuxt', () => {
    pkg({ nuxt: '3' });
    files('pages/index.vue', 'pages/team.vue', 'pages/users/[id].vue');
    assert.deepEqual(detect(t.dir).pages, ['/', '/team']);
  });

  it('SvelteKit: +page files, groups dropped', () => {
    pkg({ '@sveltejs/kit': '2' });
    files('src/routes/+page.svelte', 'src/routes/(app)/settings/+page.svelte', 'src/routes/+layout.svelte', 'src/routes/post/[id]/+page.svelte');
    const d = detect(t.dir);
    assert.equal(d.local.url, 'http://localhost:5173');
    assert.deepEqual(d.pages, ['/', '/settings']);
  });

  it('Gatsby', () => {
    pkg({ gatsby: '5' });
    files('src/pages/index.js', 'src/pages/404.js');
    const d = detect(t.dir);
    assert.equal(d.local.url, 'http://localhost:8000');
    assert.deepEqual(d.pages, ['/', '/404']);
  });

  it('Vite multi-page: html files outside public/ and build output', () => {
    pkg({ vite: '6' });
    files('index.html', 'about.html', 'docs/index.html', 'public/x.html', 'dist/index.html', 'node_modules/a/b.html');
    assert.deepEqual(detect(t.dir).pages, ['/', '/about.html', '/docs/']);
  });

  for (const [dep, name, port] of [
    ['@remix-run/dev', 'Remix', 5173], ['@react-router/dev', 'React Router', 5173], ['@angular/core', 'Angular', 4200],
    ['react-scripts', 'Create React App', 3000], ['@vue/cli-service', 'Vue CLI', 8080], ['@11ty/eleventy', 'Eleventy', 8080],
  ] as const) {
    it(`${name}: framework + port, "/" as the only page`, () => {
      pkg({ [dep]: '1' });
      const d = detect(t.dir);
      assert.equal(d.framework, name);
      assert.equal(d.local.url, `http://localhost:${port}`);
      assert.deepEqual(d.pages, ['/']);
    });
  }

  it('first matching framework wins (Next.js over Vite-like deps)', () => {
    pkg({ vite: '6', next: '15' });
    assert.equal(detect(t.dir).framework, 'Next.js');
  });

  it('plain static site: serves the folder', () => {
    files('index.html', 'contact.html');
    const d = detect(t.dir);
    assert.equal(d.framework, 'unknown');
    assert.equal(d.local.command, 'npx --yes serve -l 3000 .');
    assert.deepEqual(d.pages, ['/', '/contact.html']);
  });

  it('empty folder', () => {
    const d = detect(t.dir);
    assert.equal(d.framework, 'static');
    assert.equal(d.local.command, null);
    assert.deepEqual(d.pages, ['/']);
  });

  it('caps at 50 pages, "/" first, rest sorted', () => {
    pkg({ astro: '5' });
    for (let i = 0; i < 60; i++) files(`src/pages/p${String(i).padStart(2, '0')}.astro`);
    files('src/pages/index.astro');
    const { pages } = detect(t.dir);
    assert.equal(pages.length, 50);
    assert.equal(pages[0], '/');
    assert.equal(pages[1], '/p00');
  });
});

describe('detect: dev command and port', () => {
  it('prefers dev, then start, serve, preview', () => {
    pkg({}, { preview: 'p', start: 's' });
    assert.equal(detect(t.dir).local.command, 'npm run start');
    pkg({}, { preview: 'p' });
    assert.equal(detect(t.dir).local.command, 'npm run preview');
  });

  for (const [lock, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']]) {
    it(`uses ${pm} when ${lock} exists`, () => {
      pkg({ astro: '5' });
      files(lock);
      assert.equal(detect(t.dir).local.command, `${pm} run dev`);
    });
  }

  for (const script of ['astro dev --port 4999', 'next dev -p 4999', 'vite --port=4999']) {
    it(`reads the port from "${script}"`, () => {
      pkg({ astro: '5' }, { dev: script });
      assert.equal(detect(t.dir).local.url, 'http://localhost:4999');
    });
  }
});

describe('detect: remote URL', () => {
  it('from package.json homepage', () => {
    pkg({}, {}, { homepage: 'https://home.dev' });
    assert.equal(detect(t.dir).remote, 'https://home.dev');
  });

  it('ignores a non-URL homepage', () => {
    pkg({}, {}, { homepage: '.' });
    assert.equal(detect(t.dir).remote, null);
  });

  for (const [file, src] of [
    ['astro.config.mjs', "export default { site: 'https://astro.dev' }"],
    ['docusaurus.config.js', 'module.exports = { url: "https://docs.dev" }'],
    ['gatsby-config.js', 'module.exports = { siteMetadata: { siteUrl: `https://gatsby.dev` } }'],
  ]) {
    it(`from ${file}`, () => {
      t.write(file, src);
      assert.match(detect(t.dir).remote ?? '', /^https:\/\/\w+\.dev$/);
    });
  }

  it('from CNAME', () => {
    t.write('CNAME', 'www.example.org\n');
    assert.equal(detect(t.dir).remote, 'https://www.example.org');
  });
});

describe('init', () => {
  it('writes config, npm script and .gitignore entry', async () => {
    pkg({ astro: '5' });
    t.write('.gitignore', 'node_modules\n');
    files('src/pages/index.astro');
    const r = await init({ cwd: t.dir, remote: 'https://ref.dev', yes: true, log: quiet });
    assert.equal(r.created, true);
    assert.equal(r.needsRemote, false);
    const cfg = JSON.parse(t.read('argus.config.json'));
    assert.equal(cfg.remote, 'https://ref.dev');
    assert.equal(cfg.local.url, 'http://localhost:4321');
    assert.deepEqual(cfg.pages, ['/']);
    assert.equal(cfg.refs, 'designs/{page}-{viewport}.png');
    assert.deepEqual(Object.keys(cfg.viewports), ['desktop', 'tablet', 'mobile']);
    assert.equal(JSON.parse(t.read('package.json')).scripts.argus, 'argus');
    assert.match(t.read('.gitignore'), /^\/argus\/$/m);
  });

  it('is idempotent: keeps an existing config, script and .gitignore entry', async () => {
    pkg({ astro: '5' });
    t.write('.gitignore', '/argus/\n');
    await init({ cwd: t.dir, remote: 'https://a.dev', yes: true, log: quiet });
    const before = [t.read('argus.config.json'), t.read('package.json'), t.read('.gitignore')];
    const r = await init({ cwd: t.dir, remote: 'https://b.dev', yes: true, log: quiet });
    assert.equal(r.created, false);
    assert.equal(r.config?.remote, 'https://a.dev');
    assert.deepEqual([t.read('argus.config.json'), t.read('package.json'), t.read('.gitignore')], before);
  });

  it('--force regenerates the config', async () => {
    await init({ cwd: t.dir, remote: 'https://a.dev', yes: true, log: quiet });
    await init({ cwd: t.dir, remote: 'https://b.dev', yes: true, force: true, log: quiet });
    assert.equal(JSON.parse(t.read('argus.config.json')).remote, 'https://b.dev');
  });

  it('does not overwrite an existing "argus" script', async () => {
    pkg({}, { argus: 'argus --viewport mobile' });
    await init({ cwd: t.dir, remote: 'https://a.dev', yes: true, log: quiet });
    assert.equal(JSON.parse(t.read('package.json')).scripts.argus, 'argus --viewport mobile');
  });

  it('preserves package.json indentation', async () => {
    t.write('package.json', JSON.stringify({ name: 'x', scripts: {} }, null, 4));
    await init({ cwd: t.dir, remote: 'https://a.dev', yes: true, log: quiet });
    assert.match(t.read('package.json'), /^ {4}"name"/m);
  });

  it('uses the detected remote when none is given', async () => {
    pkg({}, {}, { homepage: 'https://home.dev' });
    await init({ cwd: t.dir, yes: true, log: quiet });
    assert.equal(JSON.parse(t.read('argus.config.json')).remote, 'https://home.dev');
  });

  it('writes a placeholder and reports needsRemote when no remote is known', async () => {
    const r = await init({ cwd: t.dir, yes: true, log: quiet });
    assert.equal(r.needsRemote, true);
    assert.equal(JSON.parse(t.read('argus.config.json')).remote, 'https://example.com');
  });

  it('works without package.json or .gitignore', async () => {
    await init({ cwd: t.dir, remote: 'https://a.dev', yes: true, log: quiet });
    assert.ok(fs.existsSync(path.join(t.dir, 'argus.config.json')));
    assert.ok(!fs.existsSync(path.join(t.dir, 'package.json')));
    assert.ok(!fs.existsSync(path.join(t.dir, '.gitignore')));
  });
});
