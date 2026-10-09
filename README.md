# Argus

**Does what you built match the real thing?** Argus compares your local site, page by page and at desktop, tablet and mobile sizes, against a **live reference site** and/or **design images**. It tells you how much changed and *which element* changed.

```bash
npm i -D @kaze-no-ryuu/argus && npx playwright install chromium
npx argus
```

The first run detects your framework, writes a config and adds an `argus` npm script. Every run after that starts your dev server, screenshots everything, diffs it and writes one HTML report.

## Why Argus

- **Zero-config start.** Detects Next.js, Astro, Nuxt, SvelteKit, Vite and others, the dev command and port, and every route. No test files to write.
- **Compares against a live site *and* designs in one run.** Rebuilding or migrating a site? Point it at production. Building from mockups? Drop PNGs in `designs/`. Mix both per page and per viewport.
- **Says where, not just how much.** Each changed area is labeled with the elements it falls in (`section#pricing`, `h2 "Plans"`), so you can jump straight to the code.
- **Catches layout shifts.** A page that got taller or shorter (missing or extra content) is flagged on its own, with the height difference. A pixel diff alone hides this.
- **Built for AI agents and CI.** `--json` output with absolute file paths, `failed` flags and element labels, plus clear exit codes (`0` / `1` / `2`). An agent can run → read → fix → re-run with no human in the loop.
- **Runs your dev server for you.** Starts it, waits until it responds, and stops it afterwards. If it's already running, it's reused.
- **One self-contained report.** A pass/fail grid, % per page × viewport, the list of changed areas, and a diff / reference / local / side-by-side viewer. Works in light and dark mode.
- **Fast and safe to run in parallel.** Parallel tabs sized to your CPU and memory, CI sharding, remote browsers, and a lock so parallel runs can't overwrite each other.

### Compared to alternatives

| | Argus | BackstopJS | Playwright `toHaveScreenshot` | Percy / Chromatic / Applitools |
|---|:-:|:-:|:-:|:-:|
| Live site vs local (no stored screenshots) | ✓ | ✓ | — | — |
| Design images as reference | ✓ | manual | — | — |
| Detects framework, routes, dev server | ✓ | — | — | — |
| Names the changed elements | ✓ | — | — | — |
| JSON made for agents | ✓ | — | — | API |
| Review dashboard / approval flow | — | — | — | ✓ |
| Self-hosted, free | ✓ | ✓ | ✓ | — |

Use the hosted services when you need a team review flow for screenshots that change over time. Use Argus when the question is "does my build match *that*?"

## Quick start

```bash
npm i -D @kaze-no-ryuu/argus
npx playwright install chromium   # once, downloads the browser
npx argus init                    # detects your framework, writes argus.config.json, adds an npm script
npm run argus
```

Running `npx argus` without a config does the `init` step for you.

> The npm package is `@kaze-no-ryuu/argus` and the command is `argus`. Without a local install, run `npx @kaze-no-ryuu/argus` instead. `npx argus` would fetch an unrelated package.

`init` detects:

| | |
|---|---|
| Framework | Next.js, Astro, Nuxt, SvelteKit, Gatsby, Remix, React Router, Angular, CRA, Vue CLI, Eleventy, Vite, plain HTML |
| Start command | the `dev` / `start` / `serve` / `preview` script, using your package manager (npm, pnpm, yarn, bun) |
| Local URL | the framework's default port, or a `--port` / `-p` in the script |
| Pages | routes from `pages/`, `app/`, `src/pages/`, `src/routes/`, or `*.html` files (dynamic `[slug]` routes are skipped) |
| Remote URL | `homepage` in package.json, `site:` in the framework config, or `CNAME`. Otherwise it asks, or takes `--remote URL` |

## Config: `argus.config.json`

```json
{
  "remote": "https://www.example.com",
  "local": { "url": "http://localhost:4321", "command": "npm run dev" },
  "pages": [
    "/",
    "/about",
    { "path": "/pricing", "local": "/pricing.html" },
    { "path": "/contact", "ref": { "desktop": "mockups/contact.png" } }
  ],
  "refs": "designs/{page}-{viewport}.png",
  "viewports": {
    "desktop": { "width": 1440, "height": 900 },
    "tablet":  { "width": 768,  "height": 1024, "isMobile": true },
    "mobile":  { "width": 390,  "height": 844,  "isMobile": true }
  },
  "threshold": 0.1,
  "imageThreshold": 1,
  "out": "argus",
  "diffDir": "argus/diffs",
  "report": "argus/report.html",
  "css": ".reveal{opacity:1!important;transform:none!important}"
}
```

| key | meaning |
|---|---|
| `remote` | Reference site. Each page path is appended to it. Optional if every page has a reference image. |
| `refs` | Path pattern for reference images (PNG). Wherever a matching file exists, it is used instead of the remote screenshot. `{page}` is the page name (`index`, `about`, `blog-post`), `{viewport}` the viewport key. |
| `pages[].ref` | Reference image for one page: `"x.png"` for all viewports, or `{ "mobile": "x.png" }`. Takes priority over `refs`. |
| `local.url` / `local.command` | If `url` already responds, that server is used. Otherwise `command` is started, awaited, and stopped afterwards (its output goes to `<out>/server.log`). |
| `pages` | Paths, or `{ path, remote, local, name }` when the two sites use different URLs (relative paths or full URLs). |
| `viewports` | Any number of them. Optional: `deviceScaleFactor` (default 1), `isMobile`, `userAgent`. |
| `threshold` | Max % of changed pixels per page and viewport before it fails. |
| `imageThreshold` | Same, for checks against reference images (defaults to `threshold`). Design tools draw text slightly differently from browsers, so a looser value is common. |
| `out` / `diffDir` / `report` | Where screenshots, diff images and the HTML report go. |
| `css` | Injected into both sites before the screenshot, e.g. to finish scroll animations or hide cookie banners. |
| `settle`, `serverTimeout`, `concurrency` | Wait (ms) before each screenshot (default 300), time to wait for the dev server to start (default 120000), number of parallel tabs. |

Before each screenshot, the page is scrolled from top to bottom so scroll-triggered animations play.

## Comparing against design images

Export each frame as PNG at 1×, name it `<page>-<viewport>.png` and put it in `designs/` (e.g. `designs/index-desktop.png`, `designs/about-mobile.png`). Pages or viewports without an image still compare against `remote`.

- The image width must equal the viewport width × `deviceScaleFactor`. A 375px mobile frame needs `"mobile": { "width": 375, … }`. If the width is wrong, that check shows an error explaining it.
- A height difference is only a **warning** for images, because design frames rarely match the real page height. The pixel diff and changed areas are still reported.

## Output

```
argus/
  report.html                  one-page report: pass/fail matrix, % per page × viewport, changed areas, image viewer
  desktop/about-remote.png     screenshots
  desktop/about-local.png
  diffs/desktop/about.png      changed pixels in red
```

A check **fails** when it changed more than the threshold, when the page size differs from the remote screenshot (missing or extra content), or when it errors (HTTP ≥ 400, timeout, missing or wrong-width image). Each result has `"failed": true/false` and `"refType": "remote" | "image"`.

## CLI

```
argus init [--remote URL] [--force] [-y]
argus [-c config] [-p /about,/faq] [--viewport mobile] [--json] [--open]
          [--no-server] [--no-shoot] [-j N] [--shard k/n] [--browser-ws URL]
```

Exit codes: `0` everything within the threshold, `1` diffs found, `2` error.

## For AI agents

```bash
npx argus --json
```

```json
{
  "ok": false, "threshold": 0.1, "report": "/abs/argus/report.html",
  "counts": { "total": 6, "passed": 4, "failed": 2, "errors": 0 },
  "failed": ["about@mobile", "about@desktop"],
  "results": [{
    "page": "about", "viewport": "mobile", "status": "diff",
    "diffPercentage": 3.42, "diffCount": 11873, "sizeMismatch": true,
    "size": { "remote": { "width": 390, "height": 2400 }, "local": { "width": 390, "height": 2520 } },
    "bands": [{ "y1": 812, "y2": 1104, "height": 293, "where": ["section#pricing", "h2 \"Plans\""] }],
    "refType": "remote", "failed": true,
    "remote": "…/mobile/about-remote.png", "local": "…/mobile/about-local.png", "diff": "…/diffs/mobile/about.png"
  }]
}
```

A fix loop that works well:

1. Go through `failed` and start with `sizeMismatch` entries. A different height means content is missing or extra, which shifts everything below it. Fix those first.
2. Use `bands[].where` to find the element in your code, and open the `diff` PNG next to the `remote` and `local` PNGs to see what changed.
3. Re-run only what you touched: `npx argus --json -p /about --viewport mobile`.

## Scaling

- `-j N` sets how many tabs run at once. By default it's picked from your CPU and memory (container limits included).
- `--shard k/n` splits the checks across CI jobs. Give each shard its own `out`.
- `--browser-ws ws://…` uses a remote browser (`npx playwright run-server`, Browserless).
- Runs that share an `out` folder wait for each other through a lock file instead of overwriting each other's files.

## API

```js
import { loadConfig, run } from '@kaze-no-ryuu/argus';
const result = await run(loadConfig('argus.config.json'), { viewports: ['mobile'] });
```

`detect(cwd)` and `init(opts)` are exported from `@kaze-no-ryuu/argus/init`. TypeScript types are included (`Config`, `RawConfig`, `Result`, `Summary`, …).

## Development

Requires Node 22.18 or newer. The tests run the TypeScript source directly.

```bash
npm install && npx playwright install chromium
npm run typecheck   # tsc, source and tests
npm test            # unit, init/detection, CLI and end-to-end (real browser) tests
npm run test:coverage
npm run build       # src/ → dist/
```

## License

MIT
