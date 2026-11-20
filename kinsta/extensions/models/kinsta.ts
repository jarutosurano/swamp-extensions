// Sites, environments and backups of a Kinsta company, through the Kinsta API.
// `sites` and `backups` only read. `create_backup` asks Kinsta for one manual
// backup of one environment and waits until Kinsta lists it. Nothing here
// restores, deletes, pushes or changes a site, reads a local file or starts
// another program. Every request goes to https://api.kinsta.com/v2 and carries
// the API key in the Authorization header; the key is never logged, stored or
// put in an error message.
import { z } from "npm:zod@4.6.7";

const HOST = "api.kinsta.com";
const API = `https://${HOST}/v2`;

/** A Kinsta id (company, site, environment): a lowercase UUID. It goes into request URLs. */
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A backup tag this extension will send: lowercase letters and digits in groups joined by single hyphens. */
export const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An API key as it may travel in a header: 16 to 512 visible ASCII characters, no space, no line break. */
export const KEY = /^[\x21-\x7e]{16,512}$/;

const GlobalArgsSchema = z.object({
  apiKey: z.string().regex(
    KEY,
    "an API key: 16 to 512 visible characters without spaces",
  ).refine(
    (v) => !v.includes("${{"),
    "an API key, not an expression that was left unresolved",
  ).meta({ sensitive: true }).describe(
    "Kinsta API key. Keep it in a vault and reference it with a vault.get expression; never write the key itself in a definition",
  ),
  companyId: z.string().regex(UUID, "a Kinsta company id (a lowercase UUID)")
    .describe(
      "Kinsta company id (MyKinsta > Company settings > Billing details shows it), a UUID",
    ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SitesArgsSchema = z.object({});

const EnvArg = z.string().regex(
  UUID,
  "a Kinsta environment id (a lowercase UUID)",
).describe(
  "Environment id, a UUID. The sites method lists the environments of every site with their ids",
);

const BackupsArgsSchema = z.object({ environmentId: EnvArg });

const CreateBackupArgsSchema = z.object({
  environmentId: EnvArg,
  tag: z.string().max(40).regex(
    TAG,
    "lowercase letters and digits, groups joined by single hyphens, 40 characters at most",
  ).describe(
    "Tag (note) of the new backup, e.g. before-plugin-update. Lowercase letters, digits and single hyphens, up to 40 characters",
  ),
  waitMinutes: z.number().min(1).max(60).default(15).describe(
    "About how long to wait for Kinsta to list the new backup before the run fails",
  ),
  pollSeconds: z.number().min(5).max(300).default(15).describe(
    "Seconds between two reads of the backup list while waiting",
  ),
  manualLimit: z.number().int().min(1).max(100).default(5).describe(
    "How many manual backups Kinsta keeps for one environment (5 unless your account differs)",
  ),
  whenFull: z.enum(["refuse", "proceed"]).default("refuse").describe(
    "At the manual limit: refuse (default, nothing is requested) or proceed and let Kinsta decide what happens to the oldest one",
  ),
  reuseWithinMinutes: z.number().min(0).max(1440).default(60).describe(
    "When a manual backup with the same tag was made in the last this-many minutes, record that one instead of asking for another. 0 always asks for a new one",
  ),
});
type CreateBackupArgs = z.infer<typeof CreateBackupArgsSchema>;

const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  displayName: z.string().nullable(),
  isPremium: z.boolean().nullable(),
  // Kinsta's own flag: an operation (a push, a restore) is running on the environment
  isBlocked: z.boolean().nullable(),
  primaryDomain: z.string().nullable(),
  wordpressVersion: z.string().nullable(),
  phpVersion: z.string().nullable(),
});
type Environment = z.infer<typeof EnvironmentSchema>;

const SiteSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  displayName: z.string().nullable(),
  status: z.string().nullable(),
  labels: z.array(z.string()),
  environments: z.array(EnvironmentSchema),
});
type Site = z.infer<typeof SiteSchema>;

const SitesSchema = z.object({
  companyId: z.string(),
  siteCount: z.number(),
  environmentCount: z.number(),
  sites: z.array(SiteSchema),
  checkedAt: z.string(),
});

const BackupSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  // the tag given when a manual backup was made; Kinsta's own text for the others
  note: z.string().nullable(),
  // "manual", or one of Kinsta's own kinds such as "autodaily"
  type: z.string().nullable(),
  createdAt: z.string().nullable(),
});

const BackupsSchema = z.object({
  environmentId: z.string(),
  environmentName: z.string().nullable(),
  backupCount: z.number(),
  manualCount: z.number(),
  backups: z.array(BackupSchema),
  checkedAt: z.string(),
});

const CreatedBackupSchema = z.object({
  environmentId: z.string(),
  id: z.number(),
  name: z.string().nullable(),
  tag: z.string(),
  createdAt: z.string().nullable(),
  // true when a recent backup with the same tag was found and nothing new was requested
  reused: z.boolean(),
  // Kinsta's id of the request; null when the backup was reused
  operationId: z.string().nullable(),
  manualCount: z.number(),
  attempts: z.number(),
  checkedAt: z.string(),
});
type CreatedBackup = z.infer<typeof CreatedBackupSchema>;

type Init = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};
/** One HTTP request to the Kinsta API. Tests pass their own. */
export type Fetcher = (url: string, init: Init) => Promise<Response>;

/** Milliseconds one request to Kinsta may take. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Most bytes read from one answer. A company's whole site list comes in one answer. */
export const MAX_BODY_BYTES = 10_000_000;
/** Longest value kept from anything Kinsta sends back. */
export const MAX_VALUE_CHARS = 200;
/** Most sites, environments of one site, labels of one site and backups of one environment kept. More stops the run. */
export const MAX_SITES = 5000;
export const MAX_ENVIRONMENTS = 100;
export const MAX_LABELS = 100;
export const MAX_BACKUPS = 2000;
/** A failed read (network error or a 5xx) is repeated this many times. A write is never repeated. */
export const READ_RETRIES = 2;
/** A "too many requests" answer to a read is waited out this many times. A write is never sent again. */
export const LIMIT_RETRIES = 3;
/** Longest single wait Kinsta's Retry-After can ask for; a longer one is cut to this. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** A backup stamped this far in the future is not trusted as "recent" (clock difference allowance). */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** The signal of one request: the timeout, joined with swamp's cancel signal when there is one. The timeout always applies. */
export function requestSignal(
  cancel?: AbortSignal,
  ms = REQUEST_TIMEOUT_MS,
): AbortSignal {
  return cancel
    ? AbortSignal.any([cancel, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
}

/**
 * One request with a timeout. Refuses any URL that is not https://api.kinsta.com/v2/... and never follows a redirect,
 * so the Authorization header can go nowhere else. `cancel` (swamp's own cancel signal) stops the request early.
 */
export const kinstaFetch = async (
  url: string,
  init: Init,
  cancel?: AbortSignal,
): Promise<Response> => {
  const u = new URL(url);
  if (
    u.protocol !== "https:" || u.hostname !== HOST || u.port !== "" ||
    u.username !== "" || u.password !== "" || !u.pathname.startsWith("/v2/")
  ) {
    throw new Error(`refusing a request outside the Kinsta API: ${u.hostname}`);
  }
  const res = await fetch(u, {
    method: init.method,
    body: init.body,
    redirect: "manual",
    signal: requestSignal(cancel),
    headers: {
      ...init.headers,
      "user-agent":
        "swamp-kinsta (+https://github.com/jarutosurano/swamp-extensions)",
    },
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(
      `${HOST} answered with a redirect (${res.status}); not followed`,
    );
  }
  return res;
};

/** An answer larger than this extension reads. It is never retried. */
export class BodyTooLarge extends Error {}

/** Reads at most `max` bytes of a response body; past that it stops the download and throws BodyTooLarge. */
export async function readBody(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > max - total) {
      await reader.cancel();
      throw new BodyTooLarge(`the answer is larger than ${max} bytes`);
    }
    total += value.length;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

/**
 * Text from Kinsta is data, never trusted: control, format (bidi, zero-width), line-separator and unassigned characters
 * out, one line, at most MAX_VALUE_CHARS. The opening of a swamp expression is broken up so stored text can never read
 * as one. It is NOT escaped for HTML or chat markup: escape it where you display it.
 */
export function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // far more than is kept, so a huge value is never walked in full
  const s = v.slice(0, MAX_VALUE_CHARS * 20).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cs}\p{Cn}\u2800]+/gu,
    " ",
  ).replace(/\$\{\{/g, "$ {{").replace(/\s+/g, " ").trim();
  // cut on whole characters, never through the middle of one
  const cut = [...s].slice(0, MAX_VALUE_CHARS).join("").trim();
  return cut === "" ? null : cut;
}

/** A host name as Kinsta lists it, lower case; null when it is not shaped like one. */
export function hostName(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s.length <= 253 &&
      /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/.test(s)
    ? s
    : null;
}

/** A version-like word ("6.8.3", "php8.2"): letters, digits and . + _ - characters, 1 to 40; anything else is null. */
export function versionWord(v: unknown): string | null {
  const first = clean(v)?.split(" ")[0] ?? "";
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(first) ? first : null;
}

/** A run of this many characters of the key, in any letter case, is treated as the key. */
export const KEY_FRAGMENT = 8;

/**
 * Removes the API key from a text, however it got there: the whole key and every piece of it that is KEY_FRAGMENT
 * characters or longer, in any letter case. Ordinary text that happens to share such a run with the key is removed
 * too; that is the safe side. Every error message passes through this.
 */
export function scrub(text: string, key: string): string {
  if (key.length < KEY_FRAGMENT) {
    return key ? text.split(key).join("[api key]") : text;
  }
  // ASCII letters only, so every position stays where it was
  const lower = (v: string) => v.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const k = lower(key);
  const t = lower(text);
  const pieces = new Set<string>();
  for (let i = 0; i + KEY_FRAGMENT <= k.length; i++) {
    pieces.add(k.slice(i, i + KEY_FRAGMENT));
  }
  const hit = new Uint8Array(text.length);
  let any = false;
  for (let i = 0; i + KEY_FRAGMENT <= t.length; i++) {
    if (pieces.has(t.slice(i, i + KEY_FRAGMENT))) {
      hit.fill(1, i, i + KEY_FRAGMENT);
      any = true;
    }
  }
  if (!any) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!hit[i]) out += text[i];
    else if (i === 0 || !hit[i - 1]) out += "[api key]";
  }
  return out;
}

/**
 * Text from outside (an error, Kinsta's own message) made safe to show: invisible characters that could hide a key
 * from scrub are taken out, the key is removed, and only then is the text cleaned and cut, so a cut can never leave
 * part of a key behind. Null when nothing is left.
 */
export function safeText(raw: unknown, key: string): string | null {
  if (typeof raw !== "string") return null;
  const joined = raw.slice(0, MAX_VALUE_CHARS * 20).replace(
    /[\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu,
    "",
  );
  const out = clean(scrub(joined, key));
  // a key broken up by line breaks or spaces every few characters would pass scrub piece by piece: look once more
  // with every gap closed, and show nothing at all when a piece of the key is there
  if (out !== null && holdsKey(out.replace(/\s+/g, ""), key)) {
    return "[text withheld: it held a piece of the api key]";
  }
  return out;
}

/** True when the text holds the API key or a piece of it that scrub would remove. */
export function holdsKey(text: string, key: string): boolean {
  return scrub(text, key) !== text;
}

/** A short, single-line reason from a thrown value, with the API key removed. */
export function reason(e: unknown, key: string): string {
  let text = "";
  try {
    text = e instanceof Error ? e.message : String(e);
  } catch {
    // a thrown value that cannot even be turned into text
  }
  return safeText(text, key) ?? "unknown error";
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** How long a "too many requests" answer asks us to wait: its Retry-After in seconds, 1 s at least, MAX_RETRY_AFTER_MS at most; 5 s when it gives none. */
export function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after") ?? "";
  if (!/^\d{1,6}$/.test(raw.trim())) return 5000;
  return Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(1000, Number(raw.trim()) * 1000),
  );
}

type Deps = {
  fetcher?: Fetcher;
  cancel?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
};
type Answer = { status: number; body: Record<string, unknown> };

/** The wait used between tries. A wait that is cut short (the run was cancelled) throws a scrubbed error like every other path. */
function pauser(deps: Deps, key: string): (ms: number) => Promise<void> {
  const wait = deps.wait ?? ((ms: number) => sleep(ms, deps.cancel));
  return async (ms: number) => {
    try {
      await wait(ms);
    } catch (e) {
      throw new Error(`cancelled: ${reason(e, key)}`);
    }
  };
}

/**
 * One call to the Kinsta API, answered as its HTTP status and JSON object. The key goes only into the Authorization
 * header. A read is repeated after a network error, a broken or half-finished answer or a 5xx (READ_RETRIES times) and
 * waits out a 429 (LIMIT_RETRIES times). A write is sent exactly once, whatever the answer. Anything that is not a JSON
 * object throws.
 */
export async function call(
  key: string,
  method: "GET" | "POST",
  path: string,
  deps: Deps = {},
  body?: Record<string, unknown>,
): Promise<Answer> {
  const fetcher = deps.fetcher ??
    ((url: string, init: Init) => kinstaFetch(url, init, deps.cancel));
  const pause = pauser(deps, key);
  const init: Init = {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const read = method === "GET";
  let failed = 0;
  let limited = 0;
  while (true) {
    let status = 0;
    let text = "";
    let again: "limited" | "failed" | null = null;
    let waitMs = 0;
    try {
      const res = await fetcher(`${API}${path}`, init);
      status = res.status;
      if (read && status === 429 && limited < LIMIT_RETRIES) {
        again = "limited";
        waitMs = retryAfterMs(res);
      } else if (read && status >= 500 && failed < READ_RETRIES) {
        again = "failed";
      }
      if (again) await res.body?.cancel();
      else text = await readBody(res, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) throw e;
      // every path out of here goes through reason(), so no raw error text is ever passed on
      if (deps.cancel?.aborted) {
        throw new Error(`cancelled: ${reason(e, key)}`);
      }
      if (!read || failed >= READ_RETRIES) {
        throw new Error(`Kinsta could not be reached: ${reason(e, key)}`);
      }
      again = "failed";
    }
    let parsed: unknown;
    if (!again) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // an answer that stopped half-way reads like this; a read is tried again, a write never
        if (read && failed < READ_RETRIES) {
          again = "failed";
        } else {
          // the parser's own message quotes the body, so it is not passed on
          throw new Error(
            `Kinsta returned HTTP ${status} with a body that is not JSON`,
          );
        }
      }
    }
    if (again === "limited") {
      limited++;
      await pause(waitMs);
      continue;
    }
    if (again === "failed") {
      failed++;
      await pause(failed * 2000);
      continue;
    }
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      throw new Error(
        `Kinsta returned HTTP ${status} with a body that is not a JSON object`,
      );
    }
    return { status, body: parsed as Record<string, unknown> };
  }
}

/** An answer from Kinsta that is not the success we asked for, with its HTTP status. */
export class Refused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The error for an answer that is not the success we asked for: the status, Kinsta's own message (cleaned), no key. */
export function refusal(what: string, a: Answer, key: string): Refused {
  const said = safeText(
    typeof a.body.message === "string" ? a.body.message : a.body.error,
    key,
  );
  const hint = a.status === 401
    ? " (check the key in your vault and that API access is enabled for it)"
    : "";
  return new Refused(
    `Kinsta did not ${what} (HTTP ${a.status})${
      said ? `: ${said}` : ""
    }${hint}`,
    a.status,
  );
}

const bool = (v: unknown) => typeof v === "boolean" ? v : null;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};

/**
 * One environment from Kinsta's answer, reduced to the fields this extension keeps. Everything else Kinsta sends (the
 * SSH host and port, the web root, cache and container ids, the full domain list) is dropped here and never stored.
 */
export function readEnvironment(v: unknown): Environment {
  const e = obj(v);
  if (typeof e.id !== "string" || !UUID.test(e.id)) {
    throw new Error("Kinsta listed an environment without a usable id");
  }
  return {
    id: e.id,
    name: clean(e.name),
    displayName: clean(e.display_name),
    isPremium: bool(e.is_premium),
    isBlocked: bool(e.is_blocked),
    primaryDomain: hostName(obj(e.primaryDomain).name),
    wordpressVersion: versionWord(e.wordpress_version),
    phpVersion: versionWord(obj(e.container_info).php_engine_version),
  };
}

/** One site from Kinsta's answer, reduced to the fields this extension keeps. */
export function readSite(v: unknown): Site {
  const s = obj(v);
  if (typeof s.id !== "string" || !UUID.test(s.id)) {
    throw new Error("Kinsta listed a site without a usable id");
  }
  const envs = s.environments === undefined ? [] : s.environments;
  if (!Array.isArray(envs) || envs.length > MAX_ENVIRONMENTS) {
    throw new Error(
      `Kinsta's environment list for site ${s.id} is not a list of at most ${MAX_ENVIRONMENTS}`,
    );
  }
  const labels = Array.isArray(s.site_labels) ? s.site_labels : [];
  if (labels.length > MAX_LABELS) {
    throw new Error(
      `site ${s.id} has more than ${MAX_LABELS} labels; not read`,
    );
  }
  return {
    id: s.id,
    name: clean(s.name),
    displayName: clean(s.display_name),
    status: clean(s.status),
    labels: labels.map((l) => clean(obj(l).name)).filter((l): l is string =>
      l !== null
    ),
    environments: envs.map(readEnvironment),
  };
}

/** Every site of the company with its environments. Throws on anything but Kinsta's list. */
export async function listSites(
  key: string,
  companyId: string,
  deps: Deps = {},
): Promise<Site[]> {
  if (!UUID.test(companyId)) throw new Error("the company id is not a UUID");
  const a = await call(
    key,
    "GET",
    `/sites?company=${companyId}&include_environments=true`,
    deps,
  );
  if (a.status !== 200) throw refusal("list the company's sites", a, key);
  const sites = obj(a.body.company).sites;
  if (!Array.isArray(sites) || sites.length > MAX_SITES) {
    throw new Error(
      `Kinsta's answer holds no site list of at most ${MAX_SITES} sites`,
    );
  }
  return sites.map(readSite);
}

type Backup = z.infer<typeof BackupSchema> & { createdAtMs: number | null };

/** One backup from Kinsta's list. `created_at` counts only as a millisecond time; anything else is "unknown". */
export function readBackup(v: unknown): Backup {
  const b = obj(v);
  if (
    typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id <= 0
  ) {
    throw new Error("Kinsta listed a backup without a usable id");
  }
  const ms = typeof b.created_at === "number" &&
      Number.isSafeInteger(b.created_at) && b.created_at >= 1e12 &&
      b.created_at <= 8.64e15
    ? b.created_at
    : null;
  return {
    id: b.id,
    name: clean(b.name),
    note: clean(b.note),
    type: clean(b.type),
    createdAt: ms === null ? null : new Date(ms).toISOString(),
    createdAtMs: ms,
  };
}

/** The backups Kinsta lists for one environment (manual and automatic). Throws on anything but Kinsta's list. */
export async function listBackups(
  key: string,
  environmentId: string,
  deps: Deps = {},
): Promise<{ environmentName: string | null; backups: Backup[] }> {
  if (!UUID.test(environmentId)) {
    throw new Error("the environment id is not a UUID");
  }
  const a = await call(
    key,
    "GET",
    `/sites/environments/${environmentId}/backups`,
    deps,
  );
  if (a.status !== 200) {
    throw refusal(`list the backups of environment ${environmentId}`, a, key);
  }
  const env = obj(a.body.environment);
  if (!Array.isArray(env.backups) || env.backups.length > MAX_BACKUPS) {
    throw new Error(
      `Kinsta's answer holds no backup list of at most ${MAX_BACKUPS} backups`,
    );
  }
  return {
    environmentName: clean(env.display_name),
    backups: env.backups.map(readBackup),
  };
}

const isManual = (b: Backup) => b.type === "manual";

/** The newest manual backup carrying `tag` made in the last `windowMs`; null when there is none (or its time is unknown). */
export function recentWithTag(
  list: Backup[],
  tag: string,
  windowMs: number,
  now: number,
): Backup | null {
  const hits = list.filter((b) =>
    isManual(b) && b.note === tag && b.createdAtMs !== null &&
    now - b.createdAtMs <= windowMs && b.createdAtMs <= now + CLOCK_SKEW_MS
  );
  hits.sort((a, b) => b.createdAtMs! - a.createdAtMs! || b.id - a.id);
  return hits[0] ?? null;
}

/**
 * The backup our request made: manual, carrying our tag, with an id that was not listed before the request and, when
 * Kinsta gives its time, not made before the request (less the clock allowance).
 */
export function newBackup(
  list: Backup[],
  beforeIds: Set<number>,
  tag: string,
  requestedAt: number,
): Backup | null {
  const hits = list.filter((b) =>
    isManual(b) && b.note === tag && !beforeIds.has(b.id) &&
    (b.createdAtMs === null || b.createdAtMs >= requestedAt - CLOCK_SKEW_MS)
  );
  hits.sort((a, b) => b.id - a.id);
  return hits[0] ?? null;
}

/** Added to an error when Kinsta may have started the backup although the request did not end cleanly. */
export const MAYBE_STARTED =
  "The request may have reached Kinsta: run the backups method or check MyKinsta before asking again";

/**
 * Asks Kinsta for one manual backup and returns it only once Kinsta's own list shows it. Before asking, the list is
 * read: a recent backup with the same tag is returned instead (reuseWithinMinutes), and a full set of manual backups
 * refuses (whenFull "refuse"). The request is sent exactly once. After it the list is read every pollSeconds until the
 * new backup is there or waitMinutes ran out, which throws with the operation id. A list that cannot be read while
 * waiting is tried again at the next poll, except a clear "no" (401, 403, 404), which stops the run.
 */
export async function createBackup(
  key: string,
  environmentId: string,
  a: CreateBackupArgs,
  deps: Deps & {
    now?: () => number;
    log?: (attempt: number, state: string) => void;
  } = {},
): Promise<Omit<CreatedBackup, "checkedAt">> {
  if (!TAG.test(a.tag) || a.tag.length > 40) {
    throw new Error("the tag is not a usable backup tag; nothing requested");
  }
  const now = deps.now ?? Date.now;
  const pause = pauser(deps, key);
  const before = await listBackups(key, environmentId, deps);
  const manual = before.backups.filter(isManual);
  const recent = a.reuseWithinMinutes > 0
    ? recentWithTag(
      before.backups,
      a.tag,
      a.reuseWithinMinutes * 60_000,
      now(),
    )
    : null;
  if (recent) {
    return {
      environmentId,
      id: recent.id,
      name: recent.name,
      tag: a.tag,
      createdAt: recent.createdAt,
      reused: true,
      operationId: null,
      manualCount: manual.length,
      attempts: 0,
    };
  }
  if (manual.length >= a.manualLimit && a.whenFull !== "proceed") {
    throw new Error(
      `environment ${environmentId} already has ${manual.length} manual backups (limit ${a.manualLimit}); nothing requested. ` +
        'Delete one in MyKinsta, or pass whenFull "proceed" to let Kinsta decide what happens to the oldest',
    );
  }
  const beforeIds = new Set(before.backups.map((b) => b.id));
  const requestedAt = now();
  let posted: Answer;
  try {
    posted = await call(
      key,
      "POST",
      `/sites/environments/${environmentId}/manual-backups`,
      deps,
      { tag: a.tag },
    );
  } catch (e) {
    // no clean answer: the request was sent once and is not sent again, and nobody knows whether Kinsta acted on it
    throw new Error(`${reason(e, key)}. ${MAYBE_STARTED}`);
  }
  if (posted.status < 200 || posted.status >= 300) {
    const refused = refusal(
      `accept the backup request for environment ${environmentId}`,
      posted,
      key,
    );
    // a 4xx is a clear "no"; anything else leaves it open
    throw posted.status >= 400 && posted.status < 500
      ? refused
      : new Error(`${refused.message}. ${MAYBE_STARTED}`);
  }
  const op = typeof posted.body.operation_id === "string" &&
      /^[0-9A-Za-z:._-]{1,200}$/.test(posted.body.operation_id) &&
      // an "operation id" that holds a piece of the key is not shown or stored
      !holdsKey(posted.body.operation_id, key)
    ? posted.body.operation_id
    : null;
  if (!op) {
    throw new Error(
      `Kinsta answered HTTP ${posted.status} to the backup request but gave no usable operation id. ${MAYBE_STARTED}`,
    );
  }
  // added to every error after this point: the request is out, whatever stops the wait
  const accepted =
    `Kinsta had accepted the backup request (operation ${op}) before this: check MyKinsta or run the backups method before asking again`;
  const deadline = now() + a.waitMinutes * 60_000;
  // the clock decides, and a count backs it up in case the clock is set back while we wait
  const maxAttempts = Math.ceil(a.waitMinutes * 60 / a.pollSeconds) + 1;
  let attempts = 0;
  let last = "not listed yet";
  while (true) {
    const left = deadline - now();
    if (!(left > 0) || attempts >= maxAttempts) {
      throw new Error(
        `Kinsta accepted the backup request (operation ${op}) but no new manual backup tagged ${a.tag} was listed within ${a.waitMinutes} min (${last}). ` +
          "It may still finish: check MyKinsta or run the backups method before asking again",
      );
    }
    // never sleeps past the deadline
    try {
      await pause(Math.min(a.pollSeconds * 1000, left));
    } catch (e) {
      throw new Error(`${reason(e, key)}. ${accepted}`);
    }
    attempts++;
    try {
      const list = await listBackups(key, environmentId, deps);
      const made = newBackup(list.backups, beforeIds, a.tag, requestedAt);
      if (made) {
        deps.log?.(attempts, `backup ${made.id} is listed`);
        return {
          environmentId,
          id: made.id,
          name: made.name,
          tag: a.tag,
          createdAt: made.createdAt,
          reused: false,
          operationId: op,
          manualCount: list.backups.filter(isManual).length,
          attempts,
        };
      }
      last = "not listed yet";
    } catch (e) {
      if (deps.cancel?.aborted) {
        const why = reason(e, key);
        throw new Error(
          `${
            why.startsWith("cancelled: ") ? why : `cancelled: ${why}`
          }. ${accepted}`,
        );
      }
      // a clear "no" (wrong key, no access, no such environment) will not get better by waiting
      if (e instanceof Refused && [401, 403, 404].includes(e.status)) {
        throw new Error(`${e.message}. ${accepted}`);
      }
      last = `the list could not be read (${reason(e, key)})`;
    }
    deps.log?.(attempts, last);
  }
}

/**
 * Writes a resource, after making sure that nothing in it holds the API key or a piece of it. Kinsta has no reason to
 * send the key back in a site name or a backup note; if it ever does, nothing is stored.
 */
function store(
  context: Ctx,
  spec: string,
  name: string,
  data: Record<string, unknown>,
): Promise<{ name: string }> {
  const text = JSON.stringify(data);
  // looked at as it is, and once more with every space closed up
  if (
    holdsKey(text, context.globalArgs.apiKey) ||
    holdsKey(text.replace(/\s+/g, ""), context.globalArgs.apiKey)
  ) {
    throw new Error(
      "Kinsta's answer holds the API key or a piece of it (8 characters or more in a row); nothing was stored. " +
        "If Kinsta really sent your key back, make a new key. If a name or id only happens to share those characters with your key, a new key ends the clash too",
    );
  }
  return context.writeResource(spec, name, data);
}

type Ctx = {
  globalArgs: GlobalArgs;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  signal?: AbortSignal;
};

/** Removes the internal millisecond time before a backup is stored. */
const stored = ({ createdAtMs: _ms, ...b }: Backup) => b;

/** The @jayr/kinsta model: sites, backups and create_backup. */
export const model = {
  type: "@jayr/kinsta",
  version: "2026.11.20.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.20.2",
      description:
        "No code or schema change: published again so the registry record carries the review report",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    sites: {
      description:
        "Every site of the company with its environments (ids, names, primary domain, WordPress and PHP version)",
      schema: SitesSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    backups: {
      description: "The backups Kinsta lists for one environment",
      schema: BackupsSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    backup: {
      description:
        "The manual backup made (or found again) by create_backup for one environment",
      schema: CreatedBackupSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    sites: {
      description:
        "List every site of the company with its environments. Read-only (one GET, repeated only when it fails)",
      kind: "list",
      arguments: SitesArgsSchema,
      execute: async (
        _args: z.infer<typeof SitesArgsSchema>,
        context: Ctx,
      ) => {
        const { apiKey, companyId } = context.globalArgs;
        context.logger.info("Reading the sites of company {companyId}", {
          companyId,
        });
        const sites = await listSites(apiKey, companyId, {
          cancel: context.signal,
        });
        const environmentCount = sites.reduce(
          (n, s) => n + s.environments.length,
          0,
        );
        context.logger.info("{sites} sites, {environments} environments", {
          sites: sites.length,
          environments: environmentCount,
        });
        return {
          dataHandles: [
            await store(
              context,
              "sites",
              "sites",
              {
                companyId,
                siteCount: sites.length,
                environmentCount,
                sites,
                checkedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },
    backups: {
      description:
        "List the backups of one environment, manual and automatic. Read-only (one GET, repeated only when it fails)",
      kind: "list",
      arguments: BackupsArgsSchema,
      execute: async (
        args: z.infer<typeof BackupsArgsSchema>,
        context: Ctx,
      ) => {
        context.logger.info("Reading the backups of environment {id}", {
          id: args.environmentId,
        });
        const { environmentName, backups } = await listBackups(
          context.globalArgs.apiKey,
          args.environmentId,
          { cancel: context.signal },
        );
        const manualCount = backups.filter(isManual).length;
        context.logger.info("{count} backups, {manual} manual", {
          count: backups.length,
          manual: manualCount,
        });
        return {
          dataHandles: [
            await store(
              context,
              "backups",
              `backups-${args.environmentId}`,
              {
                environmentId: args.environmentId,
                environmentName,
                backupCount: backups.length,
                manualCount,
                backups: backups.map(stored),
                checkedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },
    create_backup: {
      description:
        "Ask Kinsta for one manual backup of one environment and wait until Kinsta lists it. Refuses at the manual limit unless told to proceed; finds a recent backup with the same tag again instead of making a second one. Fails the run when the backup is not listed in time",
      arguments: CreateBackupArgsSchema,
      execute: async (args: CreateBackupArgs, context: Ctx) => {
        context.logger.info(
          "Asking for a manual backup of environment {id} tagged {tag}",
          { id: args.environmentId, tag: args.tag },
        );
        const made = await createBackup(
          context.globalArgs.apiKey,
          args.environmentId,
          args,
          {
            cancel: context.signal,
            log: (attempt, state) =>
              context.logger.info("backup {tag} read {attempt}: {state}", {
                tag: args.tag,
                attempt,
                state,
              }),
          },
        );
        context.logger.info(
          made.reused
            ? "Found backup {backup} with this tag again; nothing new requested"
            : "Backup {backup} is listed by Kinsta",
          { backup: made.id },
        );
        return {
          dataHandles: [
            await store(
              context,
              "backup",
              `backup-${args.environmentId}`,
              { ...made, checkedAt: new Date().toISOString() },
            ),
          ],
        };
      },
    },
  },
};
