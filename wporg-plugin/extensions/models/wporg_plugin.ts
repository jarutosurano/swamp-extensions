// A plugin on the WordPress.org directory that you own, commit to or watch.
// `sync` reads the public plugin API and the plugin's SVN trunk and records
// what is out of date. `verify_release` polls WordPress.org after a release
// until the new version is served. Nothing here writes to WordPress.org, SVN
// or git, reads a local file or starts another program, and no credential is
// needed: every request is an anonymous GET to api.wordpress.org,
// plugins.svn.wordpress.org or downloads.wordpress.org.
import { z } from "npm:zod@4.6.7";

const API = "https://api.wordpress.org";
const SVN = "https://plugins.svn.wordpress.org";
const DOWNLOADS = "https://downloads.wordpress.org";

/** A WordPress.org plugin slug: lowercase letters, digits and single hyphens. It goes into request URLs. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A release version as used in an SVN tag and a download file name: starts with a digit, then letters, digits and . + _ ~ - characters. It goes into request URLs. */
export const VERSION = /^\d[0-9A-Za-z.+_~-]{0,39}$/;

const GlobalArgsSchema = z.object({
  slug: z.string().max(200).regex(
    SLUG,
    "a WordPress.org plugin slug: lowercase letters, digits and single hyphens",
  ).describe(
    "WordPress.org plugin slug, e.g. hello-dolly",
  ),
  role: z.enum(["owner", "committer", "contributor", "watch"]).default("watch")
    .describe(
      "Your relationship to the plugin (recorded with the listing, not used in any check)",
    ),
  repo: z.string().max(200).regex(
    /^(?!\.+\/)(?!.*\/\.+$)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
    "owner/name",
  ).optional().describe(
    "GitHub repo (owner/name) where the code is worked on, if any (recorded with the listing)",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SyncArgsSchema = z.object({
  staleDays: z.number().int().min(1).max(3650).default(180).describe(
    "Warn when the plugin's last update on WordPress.org is older than this",
  ),
  maxUnresolved: z.number().int().min(0).max(100000).default(5).describe(
    "Warn when more support threads than this are unresolved; up to this many is only an info flag",
  ),
});

const VerifyArgsSchema = z.object({
  version: z.string().regex(
    VERSION,
    "a version as tagged on WordPress.org, such as 1.4.2",
  ).describe("Version that should now be served, e.g. 1.4.2"),
  waitMinutes: z.number().min(0).max(120).default(30).describe(
    "Keep polling WordPress.org this long for the release to appear",
  ),
  pollSeconds: z.number().min(30).max(3600).default(60).describe(
    "Seconds between polls (30 or more, to stay polite to WordPress.org)",
  ),
});

const FlagSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warn", "fail"]),
  message: z.string(),
});
type Flag = z.infer<typeof FlagSchema>;

const ListingSchema = z.object({
  slug: z.string(),
  role: z.string(),
  repo: z.string().nullable(),
  // live | not_found (e.g. still in review) | closed
  directoryStatus: z.enum(["live", "not_found", "closed"]),
  // only for a closed plugin, when WordPress.org gives them
  closedDate: z.string().nullable(),
  closedReason: z.string().nullable(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  testedUpTo: z.string().nullable(),
  requiresWp: z.string().nullable(),
  requiresPhp: z.string().nullable(),
  // true when trunk's main file has a "WC tested up to" header at all
  wcDeclared: z.boolean(),
  wcTestedUpTo: z.string().nullable(),
  wcRequires: z.string().nullable(),
  trunkStableTag: z.string().nullable(),
  trunkVersion: z.string().nullable(),
  lastUpdated: z.string().nullable(),
  daysSinceUpdate: z.number().nullable(),
  activeInstalls: z.number().nullable(),
  rating: z.number().nullable(),
  numRatings: z.number().nullable(),
  supportThreads: z.number().nullable(),
  supportThreadsUnresolved: z.number().nullable(),
  wpLatest: z.string(),
  // null when the plugin declares no WooCommerce support, or WooCommerce's version could not be read
  wcLatest: z.string().nullable(),
  flags: z.array(FlagSchema),
  status: z.enum(["ok", "warn", "fail"]),
  checkedAt: z.string(),
});
type Listing = z.infer<typeof ListingSchema>;

const CheckSchema = z.object({
  code: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
type Check = z.infer<typeof CheckSchema>;

const ReleaseVerifySchema = z.object({
  slug: z.string(),
  version: z.string(),
  checks: z.array(CheckSchema),
  passed: z.boolean(),
  attempts: z.number(),
  checkedAt: z.string(),
});

type Fetcher = (url: string) => Promise<Response>;

/** Milliseconds one request to WordPress.org may take. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Most bytes read from one API answer or one SVN folder listing. */
export const MAX_BODY_BYTES = 1_000_000;
/** WordPress reads plugin headers from the first 8 KiB of a file; so do we, and we download no more than that. */
export const HEADER_BYTES = 8192;
/** Most root .php files of trunk looked at to find the plugin header. */
export const MAX_HEADER_FILES = 20;
/** Longest value kept from anything WordPress.org sends back. */
export const MAX_VALUE_CHARS = 200;

const HOSTS = new Set([
  "api.wordpress.org",
  "plugins.svn.wordpress.org",
  "downloads.wordpress.org",
]);

/**
 * Anonymous GET with a timeout. Refuses any host that is not WordPress.org and never follows a redirect. `cancel`
 * (swamp's own cancel signal) stops the request early.
 */
export const wporgFetch = async (
  url: string,
  cancel?: AbortSignal,
): Promise<Response> => {
  const u = new URL(url);
  if (
    u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.port !== "" ||
    u.username !== "" || u.password !== ""
  ) {
    throw new Error(`refusing a request outside WordPress.org: ${u.hostname}`);
  }
  const res = await fetch(u, {
    redirect: "manual",
    signal: cancel
      ? AbortSignal.any([cancel, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "user-agent":
        "swamp-wporg-plugin (+https://github.com/jarutosurano/swamp-extensions)",
    },
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(
      `${u.hostname} answered with a redirect (${res.status}); not followed`,
    );
  }
  return res;
};

/**
 * Reads at most `max` bytes of a response body. Past that it throws, or with `truncate` stops the download and returns
 * the first `max` bytes.
 */
export async function readBody(
  res: Response,
  max: number,
  truncate = false,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const out = new Uint8Array(max);
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - total;
    if (value.length > room) {
      await reader.cancel();
      if (!truncate) throw new Error(`the answer is larger than ${max} bytes`);
      out.set(value.subarray(0, room), total);
      total = max;
      break;
    }
    out.set(value, total);
    total += value.length;
  }
  return out.subarray(0, total);
}

/**
 * Text from WordPress.org is data, never trusted: control, format (bidi, zero-width) and line-separator characters
 * out, one line, at most MAX_VALUE_CHARS. It is NOT escaped for HTML or chat markup: escape it where you display it.
 */
export function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // control, format, line/paragraph separators, anything Unicode says to render as nothing (fillers, variation
  // selectors), private use, lone surrogates and the blank braille cell
  const s = v.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cs}⠀]+/gu,
    " ",
  ).replace(/\s+/g, " ").trim();
  // cut on whole characters, never through the middle of one
  const cut = [...s].slice(0, MAX_VALUE_CHARS).join("").trim();
  return cut === "" ? null : cut;
}

/**
 * A version-like value: the first word, kept only when it is the word "trunk" (any case) or starts with a digit and
 * is 1 to 40 letters, digits and . + _ ~ - characters. Anything else is null, so text a plugin author controls never
 * reaches a message as prose. A value such as "1.example.com" still passes: it is version-shaped.
 */
export function token(v: unknown): string | null {
  const first = clean(v)?.split(" ")[0] ?? "";
  if (/^trunk$/i.test(first)) return "trunk";
  return /^\d[0-9A-Za-z.+_~-]{0,39}$/.test(first) ? first : null;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
/** Decodes the HTML entities WordPress.org puts in a plugin name, then cleans the result. */
export function decodeName(v: unknown): string | null {
  const s = clean(v);
  if (s === null) return null;
  return clean(
    s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (
      all,
      dec,
      hex,
      name,
    ) => {
      if (name) return NAMED[name.toLowerCase()];
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : all;
    }),
  );
}

/** "8.1.2" -> [8, 1]; null when it doesn't parse. */
export function majorMinor(
  v: string | null | undefined,
): [number, number] | null {
  const m = v?.trim().match(/^(\d{1,6})\.(\d{1,6})(?![0-9])/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** True when `have` is an older major.minor than `want`. False when either does not parse: callers check that first. */
export function behind(have: string | null, want: string | null): boolean {
  const a = majorMinor(have);
  const b = majorMinor(want);
  if (!a || !b) return false;
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** Reads `Key: value` header lines from the first HEADER_BYTES of a readme.txt or plugin PHP file. The first of a key wins. */
export function readHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const raw of text.slice(0, HEADER_BYTES).split(/\r?\n/)) {
    const line = raw.slice(0, 400);
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).replace(/^[\s*#@/]+/, "").toLowerCase();
    if (!/^[a-z][a-z ]{0,39}$/.test(key) || key.endsWith(" ")) continue;
    // a markdown readme writes "**Stable tag:** 1.2.3"
    const value = clean(line.slice(colon + 1).replace(/^[\s*_]+/, ""));
    if (value !== null && !(key in out)) out[key] = value;
  }
  return out;
}

/** WP.org's "2030-05-20 9:37pm GMT" -> ISO date; null when it is not a real date. */
export function parseWporgDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return null;
  let h = Number(m[2]) % 12;
  if (m[4].toLowerCase() === "pm") h += 12;
  const iso = `${m[1]}T${String(h).padStart(2, "0")}:${m[3]}:00Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function getJson(
  fetcher: Fetcher,
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetcher(url);
  const text = new TextDecoder().decode(await readBody(res, MAX_BODY_BYTES));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${new URL(url).hostname} returned ${res.status}, not JSON`,
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      `${new URL(url).hostname} returned ${res.status}, not a JSON object`,
    );
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

/** The first `max` bytes of a text file or folder listing; null on a clear 404; any other failure throws. */
async function getText(
  fetcher: Fetcher,
  url: string,
  max: number,
): Promise<string | null> {
  const res = await fetcher(url);
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  }
  return new TextDecoder().decode(await readBody(res, max, true));
}

function infoUrl(slug: string): string {
  return `${API}/plugins/info/1.2/?action=plugin_information` +
    `&request%5Bslug%5D=${encodeURIComponent(slug)}` +
    `&request%5Bfields%5D%5Bsections%5D=0&request%5Bfields%5D%5Bversions%5D=0`;
}

/** Header lines of trunk's readme.txt, or readme.md when there is no readme.txt; null when trunk has neither. */
async function trunkReadmeHeaders(
  fetcher: Fetcher,
  slug: string,
): Promise<Record<string, string> | null> {
  for (const name of ["readme.txt", "readme.md"]) {
    const text = await getText(
      fetcher,
      `${SVN}/${slug}/trunk/${name}`,
      HEADER_BYTES,
    );
    if (text !== null) return readHeaders(text);
  }
  return null;
}

/**
 * Finds the main plugin file in trunk: a root .php whose header has both Plugin Name and Version, else the first one
 * with a Plugin Name. Looks at no more than MAX_HEADER_FILES files; null when none of them is a plugin file.
 */
async function trunkPluginHeader(
  fetcher: Fetcher,
  slug: string,
): Promise<Record<string, string> | null> {
  const listing = await getText(
    fetcher,
    `${SVN}/${slug}/trunk/`,
    MAX_BODY_BYTES,
  );
  if (!listing) return null;
  // Plain file names only: nothing from the listing can change the host or the folder of the next request.
  const phpFiles = [
    ...new Set(
      [...listing.matchAll(/href="([A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.php)"/g)]
        .map((m) => m[1]),
    ),
  ];
  // The conventional name first, then the rest.
  phpFiles.sort((
    a,
    b,
  ) => (a === `${slug}.php` ? -1 : b === `${slug}.php` ? 1 : 0));
  let nameOnly: Record<string, string> | null = null;
  for (const file of phpFiles.slice(0, MAX_HEADER_FILES)) {
    const text = await getText(
      fetcher,
      `${SVN}/${slug}/trunk/${file}`,
      HEADER_BYTES,
    );
    if (!text) continue;
    const headers = readHeaders(text);
    if (!headers["plugin name"]) continue;
    if (token(headers["version"])) return headers;
    nameOnly ??= headers;
  }
  return nameOnly;
}

/** Turns a listing into flags: closed, not listed, tested-up-to behind or unreadable, stale, unresolved support, Stable tag mismatch. */
export function assess(
  l: Omit<Listing, "flags" | "status">,
  staleDays: number,
  maxUnresolved = 5,
): Flag[] {
  const flags: Flag[] = [];
  if (l.directoryStatus === "closed") {
    flags.push({
      code: "closed",
      severity: "fail",
      message: "Plugin is closed on WordPress.org" +
        (l.closedDate ? ` since ${l.closedDate}` : "") +
        (l.closedReason ? ` (${l.closedReason})` : ""),
    });
    return flags;
  }
  if (l.directoryStatus === "not_found") {
    flags.push({
      code: "not_listed",
      severity: "warn",
      message:
        "WordPress.org does not list this slug (in review, never submitted, or a typo in the slug)",
    });
    return flags;
  }
  if (l.version === null) {
    flags.push({
      code: "version_unreadable",
      severity: "warn",
      message:
        "The version WordPress.org serves does not look like a version, so it was not stored or compared",
    });
  }
  if (!majorMinor(l.testedUpTo)) {
    flags.push({
      code: "wp_tested_unreadable",
      severity: "warn",
      message: `Tested up to is ${
        l.testedUpTo ?? "missing"
      }, so it could not be compared with WordPress ${l.wpLatest}`,
    });
  } else if (behind(l.testedUpTo, l.wpLatest)) {
    flags.push({
      code: "wp_tested_behind",
      severity: "warn",
      message: `Tested up to ${l.testedUpTo}, WordPress is ${l.wpLatest}`,
    });
  }
  if (l.wcDeclared) {
    if (!l.wcLatest || !majorMinor(l.wcTestedUpTo)) {
      flags.push({
        code: "wc_tested_unchecked",
        severity: "warn",
        message: l.wcLatest
          ? `WC tested up to is ${
            l.wcTestedUpTo ?? "not a version"
          }, so it could not be compared with WooCommerce ${l.wcLatest}`
          : `WC tested up to ${
            l.wcTestedUpTo ?? "(not a version)"
          } was not checked: WooCommerce's current version could not be read`,
      });
    } else if (behind(l.wcTestedUpTo, l.wcLatest)) {
      flags.push({
        code: "wc_tested_behind",
        severity: "warn",
        message:
          `WC tested up to ${l.wcTestedUpTo}, WooCommerce is ${l.wcLatest}`,
      });
    }
  }
  if (l.daysSinceUpdate === null) {
    flags.push({
      code: "last_update_unknown",
      severity: "info",
      message: "The date of the last update could not be read",
    });
  } else if (l.daysSinceUpdate > staleDays) {
    flags.push({
      code: "stale",
      severity: "warn",
      message: `Last update ${l.daysSinceUpdate} days ago`,
    });
  }
  if (l.supportThreadsUnresolved === null) {
    flags.push({
      code: "support_unknown",
      severity: "info",
      message: "The support thread counts could not be read",
    });
  } else if (l.supportThreadsUnresolved > 0) {
    flags.push({
      code: "support_unresolved",
      severity: l.supportThreadsUnresolved > maxUnresolved ? "warn" : "info",
      message:
        `${l.supportThreadsUnresolved} unresolved support thread(s) in the last two months`,
    });
  }
  if (l.trunkStableTag === null) {
    flags.push({
      code: "stable_tag_missing",
      severity: "warn",
      message:
        "No usable Stable tag in trunk's readme.txt or readme.md (no such file, no Stable tag in its first 8 KiB, or not version-like)",
    });
  } else if (l.trunkStableTag === "trunk") {
    flags.push({
      code: "stable_tag_trunk",
      severity: "info",
      message:
        "Trunk readme Stable tag is trunk; WordPress.org recommends a tagged version",
    });
  } else if (l.version && l.trunkStableTag !== l.version) {
    flags.push({
      code: "stable_tag_mismatch",
      severity: "warn",
      message:
        `Trunk readme Stable tag is ${l.trunkStableTag}, directory serves ${l.version}`,
    });
  }
  if (l.trunkVersion === null) {
    flags.push({
      code: "main_file_unread",
      severity: "warn",
      message:
        `No plugin header with a Version was found in the first ${MAX_HEADER_FILES} root .php files of trunk, so trunk's version was not compared`,
    });
  }
  if (l.trunkVersion && l.version && l.trunkVersion !== l.version) {
    flags.push({
      code: "trunk_unreleased",
      severity: "info",
      message:
        `Trunk header is ${l.trunkVersion}, released version is ${l.version}`,
    });
  }
  return flags;
}

/** Reads the directory listing and SVN trunk of one plugin and returns it with its flags and overall status. */
export async function syncListing(
  g: GlobalArgs,
  staleDays: number,
  fetcher: Fetcher = wporgFetch,
  now: Date = new Date(),
  maxUnresolved = 5,
  cancel?: AbortSignal,
): Promise<Listing> {
  const [info, core] = await Promise.all([
    getJson(fetcher, infoUrl(g.slug)),
    getJson(fetcher, `${API}/core/version-check/1.7/`),
  ]);
  const offers = Array.isArray(core.body.offers) ? core.body.offers : [];
  const wpLatest = token((offers[0] as { current?: unknown })?.current);
  if (core.status !== 200 || !wpLatest || !majorMinor(wpLatest)) {
    throw new Error("Could not read the current WordPress version");
  }

  const d = info.body;
  // Only WordPress.org's own three answers count: a 200 listing for this slug, its exact "not found" 404 and its
  // "closed" 404. Anything else (a 5xx, another error text, another plugin's listing) stops the run: an outage must
  // never read as "not listed".
  const directoryStatus = info.status === 404 && d.error === "closed"
    ? "closed"
    : info.status === 404 && d.error === "Plugin not found."
    ? "not_found"
    : "live";
  if (
    directoryStatus === "live" &&
    (info.status !== 200 || "error" in d || typeof d.version !== "string" ||
      d.slug !== g.slug)
  ) {
    throw new Error(
      `WordPress.org's plugin API gave no usable answer for ${g.slug} (HTTP ${info.status})`,
    );
  }

  let trunkReadme: Record<string, string> = {};
  let header: Record<string, string> | null = null;
  let wcLatest: string | null = null;
  if (directoryStatus === "live") {
    trunkReadme = await trunkReadmeHeaders(fetcher, g.slug) ?? {};
    header = await trunkPluginHeader(fetcher, g.slug);
    // WooCommerce's version is looked up only for a plugin that declares WooCommerce support, and a failed lookup
    // becomes a flag: it never stops the watch of the plugin itself.
    if (header && "wc tested up to" in header) {
      const wc = await getJson(fetcher, infoUrl("woocommerce")).catch((e) => {
        // a cancelled run stops here; only a failed lookup becomes a flag
        if (cancel?.aborted) throw e;
        return null;
      });
      const v = wc?.status === 200 && wc.body.slug === "woocommerce"
        ? token(wc.body.version)
        : null;
      wcLatest = majorMinor(v) ? v : null;
    }
  }

  const lastUpdated = directoryStatus === "live"
    ? parseWporgDate(d.last_updated)
    : null;
  // counts only: a whole number from 0 up, anything else is "could not be read"
  const num = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const age = lastUpdated
    ? Math.floor((now.getTime() - Date.parse(lastUpdated)) / 86_400_000)
    : null;
  const threads = num(d.support_threads);
  const resolved = num(d.support_threads_resolved);

  const base = {
    slug: g.slug,
    role: g.role,
    repo: g.repo ?? null,
    directoryStatus,
    closedDate: directoryStatus === "closed" &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(d.closed_date))
      ? String(d.closed_date)
      : null,
    closedReason: directoryStatus === "closed" ? clean(d.reason_text) : null,
    name: decodeName(d.name),
    version: token(d.version),
    testedUpTo: token(d.tested),
    requiresWp: token(d.requires),
    requiresPhp: token(d.requires_php),
    wcDeclared: header !== null && "wc tested up to" in header,
    wcTestedUpTo: token(header?.["wc tested up to"]),
    wcRequires: token(header?.["wc requires at least"]),
    trunkStableTag: token(trunkReadme["stable tag"]),
    trunkVersion: token(header?.["version"]),
    lastUpdated,
    // a date in the future is not a date we can use; up to a day ahead is clock difference and counts as today
    daysSinceUpdate: age !== null && age >= -1 ? Math.max(0, age) : null,
    activeInstalls: num(d.active_installs),
    rating: num(d.rating),
    numRatings: num(d.num_ratings),
    supportThreads: threads,
    supportThreadsUnresolved: threads !== null && resolved !== null
      ? Math.max(0, threads - resolved)
      : null,
    wpLatest,
    wcLatest,
    checkedAt: now.toISOString(),
  } satisfies Omit<Listing, "flags" | "status">;

  const flags = assess(base, staleDays, maxUnresolved);
  const status = flags.some((f) => f.severity === "fail")
    ? "fail"
    : flags.some((f) => f.severity === "warn")
    ? "warn"
    : "ok";
  return { ...base, flags, status };
}

// ---------------------------------------------------------------------------
// verify_release: after a person has shipped a version, poll WordPress.org
// until it is really served. Read-only, like everything else here.

/** True when the SVN tag folder exists and is the folder we asked for; false on a clear 404; anything else throws. */
async function svnTagExists(
  fetcher: Fetcher,
  slug: string,
  version: string,
): Promise<boolean> {
  const page = await getText(
    fetcher,
    `${SVN}/${slug}/tags/${version}/`,
    HEADER_BYTES,
  );
  // Subversion's own folder page: "<title>... - Revision N: /slug/tags/version</title>"
  const want = `: /${slug}/tags/${version}</title>`;
  const title = page?.match(/<title>([^<]{0,300}<\/title>)/)?.[1] ?? "";
  return title.endsWith(want);
}

/** True when the download for the version is a real zip (starts with the zip signature); false on a clear 404; anything else throws. */
async function zipServed(
  fetcher: Fetcher,
  slug: string,
  version: string,
): Promise<boolean> {
  const res = await fetcher(`${DOWNLOADS}/plugin/${slug}.${version}.zip`);
  if (res.status === 404) {
    await res.body?.cancel();
    return false;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`downloads.wordpress.org returned ${res.status}`);
  }
  const head = await readBody(res, 4, true);
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b &&
    head[2] === 0x03 && head[3] === 0x04;
}

/** One pass of the post-ship checks against WordPress.org. Throws when WordPress.org cannot be read. */
export async function verifyOnce(
  slug: string,
  version: string,
  fetcher: Fetcher = wporgFetch,
): Promise<Check[]> {
  const info = await getJson(fetcher, infoUrl(slug));
  const listed = info.status === 200 && info.body.slug === slug &&
    !("error" in info.body);
  const absent = info.status === 404 &&
    (info.body.error === "Plugin not found." || info.body.error === "closed");
  if (!listed && !absent) {
    throw new Error(
      `api.wordpress.org gave no usable answer (HTTP ${info.status})`,
    );
  }
  const served = listed ? token(info.body.version) : null;
  const stable = token(
    (await trunkReadmeHeaders(fetcher, slug))?.["stable tag"],
  );
  return [
    {
      code: "directory_version",
      passed: served === version,
      detail: `Directory serves ${served ?? "nothing"}`,
    },
    {
      code: "svn_tag",
      passed: await svnTagExists(fetcher, slug, version),
      detail: `tags/${version}/`,
    },
    {
      code: "trunk_stable_tag",
      passed: stable === version,
      detail: `trunk Stable tag ${stable ?? "missing"}`,
    },
    {
      code: "download_zip",
      passed: await zipServed(fetcher, slug, version),
      detail: `${slug}.${version}.zip`,
    },
  ];
}

/** A short, single-line reason from a thrown value. Requests here carry no secret, so there is none to leak. */
const reason = (e: unknown) =>
  clean(e instanceof Error ? e.message : String(e)) ?? "unknown error";

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

/**
 * Repeats verifyOnce until every check passes or the wait runs out. An attempt that could not reach WordPress.org is
 * retried like a failing check; `error` is set only when the LAST attempt could not reach it.
 */
export async function pollRelease(
  slug: string,
  version: string,
  opts: { waitMinutes: number; pollSeconds: number },
  deps: {
    fetcher?: Fetcher;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    log?: (attempt: number, state: string) => void;
  } = {},
): Promise<{ checks: Check[]; attempts: number; error: string | null }> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => sleep(ms));
  const deadline = now() + opts.waitMinutes * 60_000;
  let checks: Check[] = [];
  let error: string | null = null;
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      checks = await verifyOnce(slug, version, deps.fetcher ?? wporgFetch);
      error = null;
    } catch (e) {
      error = reason(e);
    }
    const failing = checks.filter((c) => !c.passed).map((c) => c.code);
    deps.log?.(
      attempts,
      error
        ? `could not read WordPress.org (${error})`
        : failing.length
        ? `waiting on ${failing.join(", ")}`
        : "all checks pass",
    );
    if (!error && !failing.length) break;
    if (now() + opts.pollSeconds * 1000 > deadline) break;
    await wait(opts.pollSeconds * 1000);
  }
  return { checks, attempts, error };
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

/** The @jayr/wporg-plugin model: sync and verify_release. */
export const model = {
  type: "@jayr/wporg-plugin",
  version: "2026.11.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    listing: {
      description: "Directory state of the plugin and what is out of date",
      schema: ListingSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    releaseVerify: {
      description: "Post-ship checks that WordPress.org serves the version",
      schema: ReleaseVerifySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    sync: {
      description:
        "Read the plugin's WordPress.org listing and SVN trunk and flag what is out of date (anonymous GETs only)",
      arguments: SyncArgsSchema,
      execute: async (args: z.infer<typeof SyncArgsSchema>, context: Ctx) => {
        const listing = await syncListing(
          context.globalArgs,
          args.staleDays,
          (url) => wporgFetch(url, context.signal),
          new Date(),
          args.maxUnresolved,
          context.signal,
        );
        context.logger.info("{slug}: {status} ({count} flags)", {
          slug: listing.slug,
          status: listing.status,
          count: listing.flags.length,
        });
        for (const f of listing.flags) {
          context.logger.info("  {severity} {code}: {message}", f);
        }
        return {
          dataHandles: [
            await context.writeResource("listing", "listing", listing),
          ],
        };
      },
    },
    verify_release: {
      description:
        "Poll WordPress.org until the version is served: directory version, SVN tag, trunk Stable tag, download zip. Fails the run when it is not served in time (anonymous GETs only)",
      arguments: VerifyArgsSchema,
      execute: async (args: z.infer<typeof VerifyArgsSchema>, context: Ctx) => {
        const slug = context.globalArgs.slug;
        const { checks, attempts, error } = await pollRelease(
          slug,
          args.version,
          args,
          {
            fetcher: (url) => wporgFetch(url, context.signal),
            wait: (ms) => sleep(ms, context.signal),
            log: (attempt, state) =>
              context.logger.info(
                "verify {version} attempt {attempt}: {state}",
                {
                  version: args.version,
                  attempt,
                  state,
                },
              ),
          },
        );
        // Nothing is recorded for an attempt that could not read WordPress.org: an outage is an error, not a result.
        if (error) {
          throw new Error(
            `WordPress.org could not be read after ${attempts} attempt(s): ${error}`,
          );
        }
        const failing = checks.filter((c) => !c.passed).map((c) => c.code);
        const handle = await context.writeResource(
          "releaseVerify",
          "releaseVerify",
          {
            slug,
            version: args.version,
            checks,
            passed: failing.length === 0,
            attempts,
            checkedAt: new Date().toISOString(),
          },
        );
        // A release that is not served must fail the run, so a workflow step can never read it as success.
        if (failing.length) {
          throw new Error(
            `${slug} ${args.version} is not served by WordPress.org after ${attempts} attempt(s): ${
              failing.join(", ")
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
