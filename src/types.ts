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
  | { path?: string; name?: string; remote?: string; local?: string; ref?: RefSpec };

/** argus.config.json as written by the user. */
export interface RawConfig {
  remote?: string;
  local: { url: string; command?: string | null };
  pages: PageSpec[];
  refs?: string;
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
  remoteUrl: string | null;
  localUrl: string;
}

export interface Box { label: string; top: number; bottom: number }

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
  refType: 'remote' | 'image';
  remoteUrl: string | null;
  localUrl: string;
  /** Reference image path (remote screenshot or design image). */
  remote: string;
  local: string;
  diff: string;
  status: 'match' | 'diff' | 'error';
  error?: string;
  diffPercentage?: number;
  diffCount?: number | null;
  size?: { remote: Size; local: Size };
  sizeMismatch?: boolean;
  bands?: Band[];
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
}
