import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { CONFIG_FILE, DEFAULTS } from './index.ts';
import type { Log, RawConfig } from './types.ts';

type Routes = (cwd: string) => string[];
interface PackageJson { homepage?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

const PLACEHOLDER = 'https://example.com';
const SELF = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name;
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|\.git|\.next|\.astro|\.svelte-kit|\.nuxt|coverage|argus)(\/|$)/;

function list(cwd: string, dir: string): string[] {
  try {
    return fs.readdirSync(path.join(cwd, dir), { recursive: true })
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => !SKIP_DIRS.test(f));
  } catch { return []; }
}

const dynamic = (seg: string) => seg.startsWith('_') || seg.startsWith('@') || seg.includes('[');

// File-based routing: pages/about.astro → /about, pages/blog/index.astro → /blog
const fileRoutes = (dirs: string[], ext: RegExp): Routes => (cwd) => dirs.flatMap((d) => list(cwd, d)
  .filter((f) => ext.test(f))
  .map((f) => f.replace(ext, '').split('/'))
  .filter((segs) => segs[0] !== 'api' && !segs.some(dynamic))
  .map((segs) => `/${(segs.at(-1) === 'index' ? segs.slice(0, -1) : segs).join('/')}`));

// Folder-based routing: app/about/page.tsx → /about, (group) folders dropped
const dirRoutes = (dirs: string[], file: RegExp): Routes => (cwd) => dirs.flatMap((d) => list(cwd, d)
  .filter((f) => file.test(f.split('/').at(-1) ?? ''))
  .map((f) => f.split('/').slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)))
  .filter((segs) => segs[0] !== 'api' && !segs.some(dynamic))
  .map((segs) => `/${segs.join('/')}`));

const htmlRoutes: Routes = (cwd) => list(cwd, '.')
  .filter((f) => /\.html$/.test(f) && !f.startsWith('public/'))
  .map((f) => (f === 'index.html' ? '/' : `/${f.replace(/(^|\/)index\.html$/, '$1')}`));

interface Framework { dep: string; name: string; port: number; routes?: Routes }

const FRAMEWORKS: Framework[] = [
  { dep: 'next', name: 'Next.js', port: 3000, routes: (cwd) => [
    ...dirRoutes(['app', 'src/app'], /^page\.(jsx?|tsx?|mdx?)$/)(cwd),
    ...fileRoutes(['pages', 'src/pages'], /\.(jsx?|tsx?|mdx?)$/)(cwd),
  ] },
  { dep: 'astro', name: 'Astro', port: 4321, routes: fileRoutes(['src/pages'], /\.(astro|mdx?|html)$/) },
  { dep: 'nuxt', name: 'Nuxt', port: 3000, routes: fileRoutes(['pages', 'app/pages'], /\.vue$/) },
  { dep: '@sveltejs/kit', name: 'SvelteKit', port: 5173, routes: dirRoutes(['src/routes'], /^\+page\.(svelte|md|svx)$/) },
  { dep: 'gatsby', name: 'Gatsby', port: 8000, routes: fileRoutes(['src/pages'], /\.(jsx?|tsx?)$/) },
  { dep: '@remix-run/dev', name: 'Remix', port: 5173 },
  { dep: '@react-router/dev', name: 'React Router', port: 5173 },
  { dep: '@angular/core', name: 'Angular', port: 4200 },
  { dep: 'react-scripts', name: 'Create React App', port: 3000 },
  { dep: '@vue/cli-service', name: 'Vue CLI', port: 8080 },
  { dep: '@11ty/eleventy', name: 'Eleventy', port: 8080 },
  { dep: 'vite', name: 'Vite', port: 5173, routes: htmlRoutes },
];

function readJson<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function packageManager(cwd: string): string {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

function findRemote(cwd: string, pkg: PackageJson | null): string | null {
  if (pkg?.homepage && /^https?:\/\//.test(pkg.homepage)) return pkg.homepage;
  for (const f of fs.readdirSync(cwd)) {
    if (!/^(astro|next|nuxt|svelte|vite|gatsby-config|docusaurus)\.config\.|^gatsby-config\./.test(f)) continue;
    const m = fs.readFileSync(path.join(cwd, f), 'utf8').match(/\b(?:site|siteUrl|url|baseUrl)\s*:\s*['"`](https?:\/\/[^'"`]+)/);
    if (m) return m[1];
  }
  try {
    const cname = fs.readFileSync(path.join(cwd, 'CNAME'), 'utf8').trim() || fs.readFileSync(path.join(cwd, 'public/CNAME'), 'utf8').trim();
    if (cname) return `https://${cname}`;
  } catch {}
  return null;
}

export interface Detected {
  framework: string;
  local: { url: string; command: string | null };
  pages: string[];
  remote: string | null;
}

export function detect(cwd = process.cwd()): Detected {
  const pkg = readJson<PackageJson>(path.join(cwd, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const fw = FRAMEWORKS.find((f) => f.dep in deps);
  const scripts = pkg?.scripts ?? {};
  const script = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
  let command = script ? `${packageManager(cwd)} run ${script}` : null;
  let port = fw?.port ?? 3000;
  const portFlag = script && scripts[script].match(/(?:--port|-p)[ =](\d{2,5})/);
  if (portFlag) port = Number(portFlag[1]);

  let pages = fw?.routes?.(cwd) ?? [];
  if (!fw && fs.existsSync(path.join(cwd, 'index.html'))) {
    pages = htmlRoutes(cwd);
    command ??= `npx --yes serve -l ${port} .`;
  }
  pages = [...new Set(pages.length ? pages : ['/'])].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b))).slice(0, 50);

  return {
    framework: fw?.name ?? (command ? 'unknown' : 'static'),
    local: { url: `http://localhost:${port}`, command },
    pages,
    remote: findRemote(cwd, pkg),
  };
}

// Writes argus.config.json and a "argus" npm script. Idempotent.
export interface InitOptions { cwd?: string; remote?: string | null; force?: boolean; yes?: boolean; log?: Log }
export interface InitResult { configPath: string; created: boolean; config: RawConfig | null; needsRemote?: boolean }

export async function init({ cwd = process.cwd(), remote, force = false, yes = false, log = console.error }: InitOptions = {}): Promise<InitResult> {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (fs.existsSync(configPath) && !force) {
    log(`${CONFIG_FILE} already exists (use --force to regenerate)`);
    return { configPath, created: false, config: readJson<RawConfig>(configPath) };
  }
  const d = detect(cwd);
  log(`detected: ${d.framework}${d.local.command ? `, start with "${d.local.command}"` : ''}, ${d.pages.length} page(s)`);

  remote ??= d.remote;
  if (!remote && !yes && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    remote = (await rl.question('Reference (remote) site URL to compare against: ')).trim() || null;
    rl.close();
  }
  const config: RawConfig & { remote: string } = {
    remote: remote || PLACEHOLDER,
    local: d.local,
    pages: d.pages,
    refs: 'designs/{page}-{viewport}.png',
    viewports: DEFAULTS.viewports,
    threshold: DEFAULTS.threshold,
    out: DEFAULTS.out,
    diffDir: `${DEFAULTS.out}/diffs`,
    report: `${DEFAULTS.out}/report.html`,
    css: DEFAULTS.css,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log(`wrote ${CONFIG_FILE}`);

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const text = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(text) as PackageJson;
    if (!pkg.scripts?.['argus']) {
      // The `argus` bin only exists when the package is installed in the project.
      const installed = SELF in { ...pkg.dependencies, ...pkg.devDependencies };
      pkg.scripts = { ...pkg.scripts, argus: installed ? 'argus' : `npx ${SELF}` };
      const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`);
      log(`added "argus" script to package.json: ${pkg.scripts.argus}`);
    }
  }
  const gi = path.join(cwd, '.gitignore');
  if (fs.existsSync(gi) && !/^\/?argus\/?$/m.test(fs.readFileSync(gi, 'utf8'))) {
    fs.appendFileSync(gi, `\n/${DEFAULTS.out}/\n`);
    log(`added /${DEFAULTS.out}/ to .gitignore`);
  }
  if (config.remote === PLACEHOLDER) log(`set "remote" in ${CONFIG_FILE} to the site you compare against`);
  return { configPath, created: true, config, needsRemote: config.remote === PLACEHOLDER };
}
