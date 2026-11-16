export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  userAgent?: string;
}

/** Reference image: one path for every viewport, or one per viewport. */
export type RefSpec = string | Record<string, string>;

export type PageSpec =
  | string
  | { path?: string; name?: string; remote?: string; local?: string; ref?: RefSpec; allow?: string[] };

/** argus.config.json as written by the user. */
export interface RawConfig {
  remote?: string;
  local: { url: string; command?: string | null };
  pages: PageSpec[];
  refs?: string;
  /** Folder of approved screenshots (`<viewport>/<page>.png`). When set, it is the reference for every check. */
  baseline?: string;
  viewports?: Record<string, Viewport>;
  threshold?: number;
  imageThreshold?: number;
  out?: string;
  diffDir?: string;
  report?: string;
  css?: string;
  settle?: number;
  serverTimeout?: number;
  concurrency?: number;
}

/** Config with defaults filled and paths made absolute. */
export interface Config extends RawConfig {
  root: string;
  viewports: Record<string, Viewport>;
  threshold: number;
  out: string;
  diffDir: string;
  report: string;
  css: string;
  settle: number;
  serverTimeout: number;
}

export interface Page {
  name: string;
  path: string | null;
  ref: RefSpec | null;
  /** CSS selectors of elements that are expected to change. */
  allow: string[];
  remoteUrl: string | null;
  localUrl: string;
}

export interface Box { label: string; top: number; bottom: number }

/** Box of an element matched by an `allow` selector, in CSS px. */
export interface AllowRect { selector: string; top: number; bottom: number; left: number; right: number }

export interface Band {
  y1: number;
  y2: number;
  rows: number;
  height: number;
  /** Smallest page elements covering the band, e.g. `section#pricing`. */
  where: string[];
}

export interface Size { width: number; height: number }

export interface Result {
  page: string;
  path: string | null;
  viewport: string;
  refType: 'remote' | 'image' | 'baseline';
  remoteUrl: string | null;
  localUrl: string;
  /**
   * Reference image path (remote screenshot, design image or baseline). When
   * `allowed` is non-empty it is a copy with the allowed areas taken from local.
   */
  remote: string;
  local: string;
  diff: string;
  /** `saved`: the screenshot was stored as the new baseline, nothing was compared. */
  status: 'match' | 'diff' | 'error' | 'saved';
  error?: string;
  diffPercentage?: number;
  diffCount?: number | null;
  size?: { remote: Size; local: Size };
  sizeMismatch?: boolean;
  bands?: Band[];
  /** `allow` selectors that matched and were excluded from the comparison. */
  allowed?: string[];
  failed?: boolean;
}

export interface Summary {
  ok: boolean;
  threshold: number;
  shard: string | null;
  report: string;
  counts: { total: number; passed: number; failed: number; errors: number };
  failed: string[];
  results: Result[];
}

export type Log = (msg: string) => void;

export interface RunOptions {
  log?: Log;
  shoot?: boolean;
  server?: boolean;
  only?: string[];
  viewports?: string[];
  concurrency?: number;
  shard?: string;
  browserWs?: string;
  /** Store local screenshots in `cfg.baseline` instead of comparing. */
  saveBaseline?: boolean;
  /** CSS selectors of elements expected to change, on every page. */
  allow?: string[];
}
