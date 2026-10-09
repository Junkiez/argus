import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { normalizeConfig, type RawConfig, type Result, type Summary } from '../src/index.ts';

export const quiet = () => {};

/** Temp dir with a write helper; removed by `cleanup`. */
export function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'));
  const write = (f: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), s);
  };
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, write, read, cleanup };
}

/** A page with a 100px header and a 200px hero, optionally followed by extra HTML. */
export const html = (hero: string, extra = '') => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="margin:0"><header id="top" style="height:100px;background:#fff"></header>
<section id="hero" style="height:200px;background:${hero}"><h2 style="margin:0;font-size:1px">Hero</h2></section>${extra}</body>`;

/** HTTP server answering from a route table; unknown routes are 404. */
export async function site(routes: Record<string, string>, port = 0) {
  const server = http.createServer((q, s) => {
    const body = routes[q.url ?? '/'];
    if (body === undefined) { s.writeHead(404).end(); return; }
    s.setHeader('content-type', 'text/html').end(body);
  }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// Binds 127.0.0.1 exactly: on macOS a wildcard bind succeeds even when another
// process listens on 127.0.0.1 at that port, so callers must use 127.0.0.1 URLs too.
export async function freePort() {
  const s = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Small viewports keep browser tests fast. */
export const VIEWPORTS = {
  desktop: { width: 400, height: 300 },
  mobile: { width: 200, height: 300, isMobile: true },
};

export const config = (root: string, raw: Partial<RawConfig>) =>
  normalizeConfig({ local: { url: 'http://localhost:1' }, pages: ['/'], viewports: VIEWPORTS, ...raw } as RawConfig, root);

/** Finds a result and narrows it to "all fields present" for terse asserts. */
export const finder = (res: Summary) => (page: string, vp: string) => {
  const r = res.results.find((x) => x.page === page && x.viewport === vp);
  assert.ok(r, `no result for ${page}@${vp}`);
  return r as Required<Result>;
};
