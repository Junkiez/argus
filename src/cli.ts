#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { run, loadConfig, CONFIG_FILE } from './index.ts';
import { init } from './init.ts';
import { fmtPct } from './report.ts';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c', default: CONFIG_FILE },
    remote: { type: 'string' },
    force: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    only: { type: 'string', short: 'p' },
    viewport: { type: 'string' },
    concurrency: { type: 'string', short: 'j' },
    shard: { type: 'string' },
    'browser-ws': { type: 'string' },
    'no-shoot': { type: 'boolean' },
    'no-server': { type: 'boolean' },
    open: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

if (a.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}

if (a.help) {
  console.log(`argus: compare your local site with a live site or design images, page by page, per viewport

  argus init [--remote URL] [--force] [-y]   detect framework, write ${CONFIG_FILE},
                                                 add "argus" npm script
  argus [options]                            start dev server, screenshot local and the
                                                 reference (remote site or design PNGs),
                                                 diff, write HTML report

  -c, --config FILE   config file (default ${CONFIG_FILE}; created by init if missing)
  -p, --only a,b      only these pages (name or path)
  --viewport a,b      only these viewports (e.g. mobile)
  -j, --concurrency N parallel tabs (default: auto from CPU/memory)
  --shard k/n         run every n-th check starting at k (CI matrix)
  --browser-ws URL    use a remote browser (Playwright server / Browserless)
  --no-server         don't start local.command; expect local.url to be up
  --no-shoot          re-diff existing screenshots only
  --open              open the HTML report when done
  --json              machine-readable result on stdout
  -y, --yes           init: never prompt
  -v, --version       print version

Exit codes: 0 all checks within threshold, 1 diffs found, 2 error.`);
  process.exit(0);
}

const log = a.json ? () => {} : (m: string) => console.error(m);
const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

try {
  if (positionals[0] === 'init') {
    const res = await init({ remote: a.remote, force: a.force, yes: a.yes || a.json, log });
    if (a.json) console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  if (positionals.length) throw new Error(`unknown command "${positionals[0]}" (see --help)`);

  if (!existsSync(a.config)) {
    log(`no ${a.config} found, running init`);
    const res = await init({ remote: a.remote, yes: a.yes || a.json, log });
    if (res.needsRemote) throw new Error(`set "remote" in ${CONFIG_FILE} (or put reference PNGs in designs/ and remove "remote"), then run argus again`);
  }

  const cfg = loadConfig(a.config);
  if (a.remote) cfg.remote = a.remote;
  const res = await run(cfg, {
    log,
    shoot: !a['no-shoot'],
    server: !a['no-server'],
    only: list(a.only),
    viewports: list(a.viewport),
    concurrency: a.concurrency ? Number(a.concurrency) : undefined,
    shard: a.shard,
    browserWs: a['browser-ws'],
  });

  if (a.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`\n${'Page'.padEnd(20)}${'Viewport'.padEnd(10)}${'Diff'.padEnd(10)}Where`);
    console.log('-'.repeat(70));
    for (const r of res.results) {
      const d = r.status === 'error' ? 'ERROR' : fmtPct(r.diffPercentage ?? 0);
      const where = r.status === 'error' ? r.error
        : [r.sizeMismatch && `height ${r.size?.remote.height}→${r.size?.local.height}`, r.bands?.[0]?.where[0]].filter(Boolean).join(', ');
      console.log(`${r.page.padEnd(20)}${r.viewport.padEnd(10)}${d.padEnd(10)}${where}`);
    }
    console.log(`\n${res.ok ? 'OK' : `FAILED: ${res.failed.join(', ')}`}\nReport: ${res.report}`);
  }
  if (a.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(cmd, [res.report], { stdio: 'ignore', detached: true }).unref();
  }
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  if (a.json) console.log(JSON.stringify({ ok: false, error: errMsg(e) }));
  else console.error(`error: ${errMsg(e)}`);
  process.exit(2);
}
