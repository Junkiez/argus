# Argus

**Does what you built match the real thing?** Argus compares your local site, page by page and at desktop, tablet and mobile sizes, against a **live reference site** and/or **design images**. It tells you how much changed and *which element* changed.

```bash
npx @kaze-no-ryuu/argus
```

That's the whole setup. The first run downloads Chromium if it isn't installed yet, detects your framework, writes a config and adds an `argus` npm script. Every run after that starts your dev server, screenshots everything, diffs it and writes one HTML report.

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
npm i -D @kaze-no-ryuu/argus      # pin the version in your project (optional, recommended for CI)
npx argus init                    # detects your framework, writes argus.config.json, adds an npm script
npm run argus                     # first run downloads Chromium (~100 MB, once)
```

On a fresh Linux machine or CI image, Chromium also needs system libraries. Install them once with `npx playwright install-deps chromium` (needs root).

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

## Visual regression: compare against an earlier version of your own site

No reference site or designs needed. Save the screenshots of a known-good state, then compare later runs against them:

```bash
npx argus --save-baseline baseline                 # on the good state (e.g. main): store screenshots, no compare
npx argus --baseline baseline                      # on your change: fails if anything looks different
npx argus --baseline baseline --allow "#pricing"   # ...except the element you meant to change
```

- The baseline is a plain folder of PNGs, `<dir>/<viewport>/<page>.png`. Where it lives is up to you: commit it, or have CI save it on every push to your main branch (as a build artifact or cache) and restore it in pull requests.
- Take the baseline on the same OS as the comparison. Fonts render differently on Windows, macOS and Linux.
- A page without a saved baseline is an error. Unlike design images, a height change fails the check.
- `"baseline": "baseline"` in the config is the same as passing `--baseline` on every run.

### Intended changes: `--allow`

`--allow` takes CSS selectors (comma-separated) of the elements you changed on purpose. They are left out of the comparison, and everything else must still match:

- If an allowed element kept its height, only its own box is ignored. A change right next to it still fails.
- If it grew or shrank, the content below it is compared at its new position, so a taller pricing table doesn't make the footer fail. The whole rows the element covers are ignored in that case.
- If the page changed height by more than the allowed elements can explain, the check fails as a size mismatch.
- Selectors are matched on the local page. For an element you removed, allow its parent instead.

Per page in the config: `{ "path": "/pricing", "allow": ["#pricing", ".plan-card"] }`. `--allow` also works against a `remote` site, but not against design images.

In the report and JSON, `allowed` lists the selectors that were excluded, and the reference image is shown with those areas already taken from local.

## Output

```
argus/
  report.html                  one-page report: pass/fail matrix, % per page × viewport, changed areas, image viewer
  desktop/about-remote.png     screenshots
  desktop/about-local.png
  diffs/desktop/about.png      changed pixels in red
```

A check **fails** when it changed more than the threshold, when the page size differs from the remote screenshot (missing or extra content), or when it errors (HTTP ≥ 400, timeout, missing or wrong-width image). Each result has `"failed": true/false` and `"refType": "remote" | "image" | "baseline"`.

## CLI

```
argus init [--remote URL] [--force] [-y]
argus [-c config] [-p /about,/faq] [--viewport mobile] [--json] [--open]
          [--no-server] [--no-shoot] [-j N] [--shard k/n] [--browser-ws URL]
          [--save-baseline DIR | --baseline DIR] [--allow "#a,.b"]
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
