import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  assess,
  behind,
  clean,
  decodeName,
  HEADER_BYTES,
  majorMinor,
  MAX_BODY_BYTES,
  MAX_HEADER_FILES,
  model,
  parseWporgDate,
  pollRelease,
  readBody,
  readHeaders,
  REQUEST_TIMEOUT_MS,
  sleep,
  SLUG,
  syncListing,
  token,
  verifyOnce,
  VERSION,
  wporgFetch,
} from "./wporg_plugin.ts";

// Everything below is made up: the plugin "example-plugin" does not exist.
const G = { slug: "example-plugin", role: "owner" as const };
const NOW = new Date("2030-06-01T00:00:00Z");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

type Route = { status?: number; body?: string | Uint8Array };
/** A fake WordPress.org: the first route whose key is part of the URL answers; no route = 404. Records every URL asked. */
function fake(routes: Record<string, Route | (() => Route)>) {
  const asked: string[] = [];
  const fetcher = (url: string) => {
    asked.push(url);
    for (const [part, r] of Object.entries(routes)) {
      // a key ending in "/" is a folder: it answers that folder only, never a file inside it
      if (part.endsWith("/") ? !url.endsWith(part) : !url.includes(part)) {
        continue;
      }
      const route = typeof r === "function" ? r() : r;
      return Promise.resolve(
        new Response((route.body ?? "") as BodyInit, {
          status: route.status ?? 200,
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetcher, asked };
}

type Routes = Record<string, Route | (() => Route)>;
/** `over` first (the first matching route answers), then every default it does not replace. */
const merge = (over: Routes, defaults: Routes): Routes => ({
  ...over,
  ...Object.fromEntries(
    Object.entries(defaults).filter(([k]) => !(k in over)),
  ),
});

const info = (over: Record<string, unknown> = {}) => ({
  body: JSON.stringify({
    name: "Example Plugin",
    slug: "example-plugin",
    version: "2.3.0",
    tested: "8.1",
    requires: "7.0",
    requires_php: "8.0",
    last_updated: "2030-05-20 9:37pm GMT",
    active_installs: 300,
    rating: 96,
    num_ratings: 12,
    support_threads: 3,
    support_threads_resolved: 3,
    ...over,
  }),
});
const CORE = { body: JSON.stringify({ offers: [{ current: "8.1.2" }] }) };
const README = { body: "=== Example Plugin ===\nStable tag: 2.3.0\n" };
const TRUNK = {
  body:
    '<ul><li><a href="../">..</a></li><li><a href="example-plugin.php">x</a></li><li><a href="readme.txt">r</a></li></ul>',
};
const MAIN = {
  body: "<?php\n/*\n * Plugin Name: Example Plugin\n * Version: 2.3.0\n */",
};
const live = (over: Routes = {}) =>
  merge(over, {
    "slug%5D=example-plugin": info(),
    "version-check": CORE,
    "trunk/readme.txt": README,
    "trunk/example-plugin.php": MAIN,
    "example-plugin/trunk/": TRUNK,
  });

Deno.test("slug and version patterns keep request URLs safe", () => {
  for (const ok of ["a", "hello-dolly", "a1-b2"]) {
    assertEquals(SLUG.test(ok), true);
  }
  for (const bad of ["", "A", "a--b", "-a", "a-", "a/b", "a.b", "a b", ".."]) {
    assertEquals(SLUG.test(bad), false);
  }
  for (
    const ok of [
      "1",
      "1.4.2",
      "2.0.0-beta.1",
      "1.0+build",
      "1.0.0_beta",
      "2.0~rc1",
    ]
  ) {
    assertEquals(VERSION.test(ok), true);
  }
  for (
    const bad of ["", "v1", "..", "1/2", "1 2", "1?x", "1#x", "1%2f", "1\n2"]
  ) {
    assertEquals(VERSION.test(bad), false);
  }
  assertEquals(VERSION.test("1" + ".1".repeat(30)), false);
});

Deno.test("wporgFetch refuses anything that is not plain https to WordPress.org", async () => {
  for (
    const url of [
      "https://example.com/",
      "http://api.wordpress.org/",
      "https://api.wordpress.org.example.com/",
      "https://api.wordpress.org:8443/",
      "https://user@api.wordpress.org/",
      "https://169.254.169.254/",
      "file:///etc/hosts",
    ]
  ) {
    await assertRejects(() => wporgFetch(url), Error, "refusing");
  }
});

Deno.test("readBody caps what is downloaded", async () => {
  const big = () => new Response(new Uint8Array(5000));
  await assertRejects(() => readBody(big(), 100), Error, "larger than");
  assertEquals((await readBody(big(), 100, true)).length, 100);
  assertEquals((await readBody(big(), 9000)).length, 5000);
  assertEquals((await readBody(new Response(null), 10)).length, 0);
});

Deno.test("clean makes remote text a short single line", () => {
  assertEquals(clean("  a\r\nb\u0000c\u001b[31m  "), "a b c [31m");
  assertEquals(clean("x".repeat(500))?.length, 200);
  assertEquals(clean(""), null);
  assertEquals(clean("   "), null);
  assertEquals(clean(12), null);
  assertEquals(clean({ toString: () => "x" }), null);
});

Deno.test("majorMinor and behind compare major.minor only", () => {
  assertEquals(majorMinor("8.1.2"), [8, 1]);
  assertEquals(majorMinor("8"), null);
  assertEquals(majorMinor("latest"), null);
  assertEquals(majorMinor("1." + "9".repeat(40)), null);
  assertEquals(behind("7.9.12", "8.1.2"), true);
  assertEquals(behind("8.1", "8.1.2"), false);
  assertEquals(behind("8.2", "8.1.2"), false);
  assertEquals(behind(null, "8.1"), false);
});

Deno.test("readHeaders reads readme and PHP docblock headers, within the first 8 KiB", () => {
  const h = readHeaders(
    "<?php\n/*\n * Plugin Name: Example Plugin\n * Version: 2.3.0\n * WC tested up to: 12.4\n * Version: 9.9.9\n */",
  );
  assertEquals(h["plugin name"], "Example Plugin");
  assertEquals(h["version"], "2.3.0"); // the first one wins
  assertEquals(h["wc tested up to"], "12.4");
  assertEquals(
    readHeaders("=== Example ===\r\nStable tag:   2.3.0  \r\n")["stable tag"],
    "2.3.0",
  );
  const late = "<?php\n" + "// licence line\n".repeat(100) +
    "/* Plugin Name: Late\n */";
  assertEquals(readHeaders(late)["plugin name"], "Late");
  assertEquals(
    readHeaders("x".repeat(9000) + "\nPlugin Name: Too Far\n")["plugin name"],
    undefined,
  );
  // names that are also object internals are just keys
  const odd = readHeaders("constructor: a\n__proto__: b\nVersion:\n");
  assertEquals(odd["constructor"], "a");
  assertEquals(odd["version"], undefined);
  assertEquals(Object.getPrototypeOf(odd), null);
});

Deno.test("readHeaders stays fast on hostile input", () => {
  const started = performance.now();
  readHeaders(" ".repeat(HEADER_BYTES));
  readHeaders("a".repeat(HEADER_BYTES));
  readHeaders(("Version:" + " ".repeat(390) + "\n").repeat(20));
  readHeaders("*".repeat(4000) + "a:" + " ".repeat(4000));
  assertEquals(performance.now() - started < 200, true);
});

Deno.test("parseWporgDate handles 12-hour WP.org dates and refuses unreal ones", () => {
  assertEquals(parseWporgDate("2030-05-20 9:37pm GMT"), "2030-05-20T21:37:00Z");
  assertEquals(
    parseWporgDate("2030-05-20 12:05am GMT"),
    "2030-05-20T00:05:00Z",
  );
  assertEquals(parseWporgDate("yesterday"), null);
  assertEquals(parseWporgDate("2030-99-99 9:37pm GMT"), null);
  assertEquals(parseWporgDate(undefined), null);
  assertEquals(parseWporgDate(12345), null);
});

const LISTING = {
  slug: "x",
  role: "committer",
  repo: null,
  directoryStatus: "live" as const,
  closedDate: null,
  closedReason: null,
  name: "X",
  version: "1.0.0",
  testedUpTo: "8.1",
  requiresWp: null,
  requiresPhp: null,
  wcDeclared: false,
  wcTestedUpTo: null,
  wcRequires: null,
  trunkStableTag: "1.0.0",
  trunkVersion: "1.0.0",
  lastUpdated: null,
  daysSinceUpdate: 10,
  activeInstalls: 10,
  rating: null,
  numRatings: null,
  supportThreads: 0,
  supportThreadsUnresolved: 0,
  wpLatest: "8.1.2",
  wcLatest: null,
  checkedAt: "",
};
const codes = (over: Partial<typeof LISTING> | Record<string, unknown>) =>
  assess({ ...LISTING, ...over } as typeof LISTING, 180).map((f) => f.code);

Deno.test("assess flags what is out of date and what could not be compared", () => {
  assertEquals(codes({}), []);
  assertEquals(
    codes({
      testedUpTo: "7.9",
      wcDeclared: true,
      wcTestedUpTo: "12.0",
      wcLatest: "12.4.1",
      daysSinceUpdate: 400,
      supportThreadsUnresolved: 1,
      trunkVersion: "1.0.1",
    }),
    [
      "wp_tested_behind",
      "wc_tested_behind",
      "stale",
      "support_unresolved",
      "trunk_unreleased",
    ],
  );
  // never silently "fine" when a value cannot be compared
  assertEquals(codes({ testedUpTo: null }), ["wp_tested_unreadable"]);
  assertEquals(codes({ testedUpTo: "latest" }), ["wp_tested_unreadable"]);
  assertEquals(codes({ wcDeclared: true, wcTestedUpTo: "12.4" }), [
    "wc_tested_unchecked",
  ]);
  assertEquals(
    codes({ wcDeclared: true, wcTestedUpTo: "soon", wcLatest: "12.4.1" }),
    [
      "wc_tested_unchecked",
    ],
  );
  assertEquals(codes({ daysSinceUpdate: null }), ["last_update_unknown"]);
  assertEquals(codes({ trunkStableTag: "trunk" }), ["stable_tag_trunk"]);
  assertEquals(codes({ trunkStableTag: "0.9.0" }), ["stable_tag_mismatch"]);
  assertEquals(codes({ directoryStatus: "closed" }), ["closed"]);
  assertEquals(codes({ directoryStatus: "not_found" }), ["not_listed"]);
});

Deno.test("syncListing reads a live plugin and never asks about WooCommerce for a plugin that does not declare it", async () => {
  const { fetcher, asked } = fake(live());
  const l = await syncListing(G, 180, fetcher, NOW);
  assertEquals(l.directoryStatus, "live");
  assertEquals(l.status, "ok");
  assertEquals(l.flags, []);
  assertEquals(l.version, "2.3.0");
  assertEquals(l.trunkVersion, "2.3.0");
  assertEquals(l.trunkStableTag, "2.3.0");
  assertEquals(l.daysSinceUpdate, 11);
  assertEquals(l.wpLatest, "8.1.2");
  assertEquals(l.wcLatest, null);
  assertEquals(asked.some((u) => u.includes("woocommerce")), false);
});

Deno.test("syncListing checks WooCommerce only when declared, and a failed lookup is a flag, not a stop", async () => {
  const wcMain = {
    body:
      "<?php\n/* Plugin Name: Example Plugin\n * Version: 2.3.0\n * WC tested up to: 12.0\n */",
  };
  const ok = await syncListing(
    G,
    180,
    fake({
      "slug%5D=woocommerce": {
        body: JSON.stringify({ slug: "woocommerce", version: "12.4.1" }),
      },
      ...live({ "trunk/example-plugin.php": wcMain }),
    }).fetcher,
    NOW,
  );
  assertEquals(ok.wcLatest, "12.4.1");
  assertEquals(ok.flags.map((f) => f.code), ["wc_tested_behind"]);
  for (
    const wc of [{ status: 503, body: "busy" }, { body: "{}" }, {
      body: JSON.stringify({ version: "soon" }),
    }]
  ) {
    const l = await syncListing(
      G,
      180,
      fake({
        "slug%5D=woocommerce": wc,
        ...live({ "trunk/example-plugin.php": wcMain }),
      }).fetcher,
      NOW,
    );
    assertEquals(l.wcLatest, null);
    assertEquals(l.flags.map((f) => f.code), ["wc_tested_unchecked"]);
    assertEquals(l.status, "warn");
  }
});

Deno.test("syncListing: a clear 404 is not_found, a closed plugin is closed", async () => {
  const notFound = await syncListing(
    G,
    180,
    fake({
      "slug%5D=example-plugin": {
        status: 404,
        body: JSON.stringify({ error: "Plugin not found." }),
      },
      "version-check": CORE,
    }).fetcher,
    NOW,
  );
  assertEquals(notFound.directoryStatus, "not_found");
  assertEquals(notFound.status, "warn");
  assertEquals(notFound.flags.map((f) => f.code), ["not_listed"]);
  const closed = await syncListing(
    G,
    180,
    fake({
      "slug%5D=example-plugin": {
        status: 404,
        body: JSON.stringify({
          error: "closed",
          closed: true,
          closed_date: "2029-01-30",
          reason_text: "Security Issue",
        }),
      },
      "version-check": CORE,
    }).fetcher,
    NOW,
  );
  assertEquals(closed.directoryStatus, "closed");
  assertEquals(closed.status, "fail");
});

Deno.test("syncListing stops on anything that is not a clear answer", async () => {
  const cases: Record<string, Record<string, Route>> = {
    "plugin API 500": {
      "slug%5D=example-plugin": { status: 500, body: "{}" },
    },
    "plugin API not JSON": {
      "slug%5D=example-plugin": { body: "<html>busy</html>" },
    },
    "plugin API array": { "slug%5D=example-plugin": { body: "[]" } },
    "plugin API null": { "slug%5D=example-plugin": { body: "null" } },
    "200 with an error": {
      "slug%5D=example-plugin": { body: JSON.stringify({ error: "x" }) },
    },
    "200 without a version": {
      "slug%5D=example-plugin": {
        body: JSON.stringify({ slug: "example-plugin" }),
      },
    },
    "answer for another plugin": {
      "slug%5D=example-plugin": info({ slug: "other-plugin" }),
    },
    "404 without an error text": {
      "slug%5D=example-plugin": { status: 404, body: "{}" },
    },
    "oversized answer": {
      "slug%5D=example-plugin": {
        body: new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20),
      },
    },
    "core API 503": { "version-check": { ...CORE, status: 503 } },
    "main file 500": { "trunk/example-plugin.php": { status: 500 } },
    "core without offers": { "version-check": { body: "{}" } },
    "core with an unreadable version": {
      "version-check": { body: JSON.stringify({ offers: [{ current: 8 }] }) },
    },
    "core with a non-numeric version": {
      "version-check": {
        body: JSON.stringify({ offers: [{ current: "latest" }] }),
      },
    },
    "trunk readme 500": { "trunk/readme.txt": { status: 500 } },
    "trunk listing 403": { "example-plugin/trunk/": { status: 403 } },
  };
  for (const [name, routes] of Object.entries(cases)) {
    await assertRejects(
      () => syncListing(G, 180, fake(live(routes)).fetcher, NOW),
      Error,
      undefined,
      name,
    );
  }
});

Deno.test("syncListing downloads only headers and only plain file names from trunk", async () => {
  const many = Array.from({ length: 60 }, (_, i) => `<a href="f${i}.php">`)
    .join("");
  const { fetcher, asked } = fake({
    "slug%5D=example-plugin": info({
      name: "Evil\u001b[31m\nName &amp; Co " + "x".repeat(400),
    }),
    "version-check": CORE,
    "trunk/readme.txt": {
      body: "Stable tag: 2.3.0\n" + "x".repeat(HEADER_BYTES) +
        "\nTested up to: 1.0\n",
    },
    "example-plugin/trunk/": {
      body:
        '<a href="https://example.com/x.php"><a href="../../other/trunk/x.php"><a href="a%2fb.php"><a href="x.php?y=1">' +
        many,
    },
  });
  const l = await syncListing(G, 180, fetcher, NOW);
  assertEquals((l.name?.length ?? 999) <= 200, true);
  assertEquals(
    [...(l.name ?? "")].some((ch) => ch.charCodeAt(0) < 32),
    false,
  );
  assertStringIncludes(l.name ?? "", "Name & Co");
  assertEquals(l.trunkVersion, null);
  assertEquals(
    asked.every((u) =>
      /^https:\/\/(api|plugins\.svn)\.wordpress\.org\//.test(u)
    ),
    true,
  );
  const php = asked.filter((u) => u.endsWith(".php"));
  assertEquals(php.length, MAX_HEADER_FILES);
  assertEquals(
    php.every((u) => /\/example-plugin\/trunk\/f\d+\.php$/.test(u)),
    true,
  );
});

const served = (over: Routes = {}) =>
  merge(over, {
    "slug%5D=example-plugin": info(),
    "trunk/readme.txt": README,
    "tags/2.3.0/": {
      body: "<title> - Revision 1: /example-plugin/tags/2.3.0</title>",
    },
    "example-plugin.2.3.0.zip": { body: ZIP },
  });
const failing = (checks: { code: string; passed: boolean }[]) =>
  checks.filter((c) => !c.passed).map((c) => c.code);

Deno.test("verifyOnce passes only when WordPress.org really serves the version", async () => {
  assertEquals(
    failing(
      await verifyOnce("example-plugin", "2.3.0", fake(served()).fetcher),
    ),
    [],
  );
  assertEquals(
    failing(
      await verifyOnce("example-plugin", "2.4.0", fake(served()).fetcher),
    ),
    ["directory_version", "svn_tag", "trunk_stable_tag", "download_zip"],
  );
  // a 200 that is not the tag folder or not a zip does not count
  assertEquals(
    failing(
      await verifyOnce(
        "example-plugin",
        "2.3.0",
        fake(served({
          "tags/2.3.0/": { body: "<html>Maintenance</html>" },
          "example-plugin.2.3.0.zip": { body: "<html>Maintenance</html>" },
        })).fetcher,
      ),
    ),
    ["svn_tag", "download_zip"],
  );
  assertEquals(
    failing(
      await verifyOnce(
        "example-plugin",
        "2.3.0",
        fake(served({ "example-plugin.2.3.0.zip": { body: "" } })).fetcher,
      ),
    ),
    ["download_zip"],
  );
});

Deno.test("verifyOnce throws when WordPress.org cannot be read", async () => {
  const outages: Record<string, Route>[] = [
    { "slug%5D=example-plugin": { status: 502, body: "{}" } },
    { "slug%5D=example-plugin": { body: "busy" } },
    { "trunk/readme.txt": { status: 500 } },
    { "tags/2.3.0/": { status: 503 } },
    { "example-plugin.2.3.0.zip": { status: 500 } },
  ];
  for (const routes of outages) {
    await assertRejects(() =>
      verifyOnce("example-plugin", "2.3.0", fake(served(routes)).fetcher)
    );
  }
});

/** A clock that only moves when pollRelease waits. */
function clock() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    wait: (ms: number) => {
      waits.push(ms);
      t += ms;
      return Promise.resolve();
    },
    waits,
  };
}

Deno.test("pollRelease retries through an outage and a slow release, then passes", async () => {
  let n = 0;
  const c = clock();
  const states: string[] = [];
  const r = await pollRelease("example-plugin", "2.3.0", {
    waitMinutes: 30,
    pollSeconds: 60,
  }, {
    fetcher: fake(served({
      "slug%5D=example-plugin": () =>
        ++n === 1
          ? { status: 503, body: "busy" }
          : n === 2
          ? info({ version: "2.2.0" })
          : info(),
    })).fetcher,
    now: c.now,
    wait: c.wait,
    log: (_, s) => states.push(s),
  });
  assertEquals(r.attempts, 3);
  assertEquals(r.error, null);
  assertEquals(failing(r.checks), []);
  assertEquals(c.waits, [60_000, 60_000]);
  assertStringIncludes(states[0], "could not read WordPress.org");
  assertEquals(states[1], "waiting on directory_version");
  assertEquals(states[2], "all checks pass");
});

Deno.test("pollRelease stops at the deadline and says what is still missing", async () => {
  const c = clock();
  const r = await pollRelease("example-plugin", "2.4.0", {
    waitMinutes: 2,
    pollSeconds: 60,
  }, { fetcher: fake(served()).fetcher, now: c.now, wait: c.wait });
  assertEquals(r.attempts, 3);
  assertEquals(r.error, null);
  assertEquals(failing(r.checks).length, 4);
  const once = await pollRelease("example-plugin", "2.4.0", {
    waitMinutes: 0,
    pollSeconds: 60,
  }, { fetcher: fake(served()).fetcher, now: c.now, wait: c.wait });
  assertEquals(once.attempts, 1);
});

Deno.test("pollRelease reports an outage on the last attempt as an error, never as a result", async () => {
  const c = clock();
  const r = await pollRelease("example-plugin", "2.3.0", {
    waitMinutes: 1,
    pollSeconds: 60,
  }, {
    fetcher: fake(served({
      "slug%5D=example-plugin": { status: 503, body: "busy" },
    })).fetcher,
    now: c.now,
    wait: c.wait,
  });
  assertEquals(r.attempts, 2);
  assertStringIncludes(r.error ?? "", "not JSON");
});

Deno.test("the model declares two read-only methods and validates its arguments", () => {
  assertEquals(Object.keys(model.methods), ["sync", "verify_release"]);
  const g = model.globalArguments;
  assertEquals(
    g.safeParse({ slug: "hello-dolly", role: "watch" }).success,
    true,
  );
  assertEquals(g.safeParse({ slug: "../x", role: "watch" }).success, false);
  assertEquals(g.safeParse({ slug: "x", role: "admin" }).success, false);
  assertEquals(
    g.safeParse({ slug: "x", role: "watch", repo: "a/b/c" }).success,
    false,
  );
  const v = model.methods.verify_release.arguments;
  assertEquals(v.parse({ version: "1.4.2" }), {
    version: "1.4.2",
    waitMinutes: 30,
    pollSeconds: 60,
  });
  assertEquals(
    v.safeParse({ version: "1.4.2", pollSeconds: 5 }).success,
    false,
  );
  assertEquals(
    v.safeParse({ version: "1.4.2", waitMinutes: 500 }).success,
    false,
  );
  assertEquals(v.safeParse({ version: "../../x" }).success, false);
  assertEquals(model.methods.sync.arguments.parse({}), {
    staleDays: 180,
    maxUnresolved: 5,
  });
});

Deno.test("verify_release fails the run when the version is not served, after recording the result", async () => {
  const written: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  const { fetcher } = fake(served());
  globalThis.fetch =
    ((input: URL | string) => fetcher(String(input))) as typeof fetch;
  const context = {
    globalArgs: G,
    logger: { info() {} },
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push(data);
      return Promise.resolve({ name });
    },
  };
  try {
    const ok = await model.methods.verify_release.execute(
      { version: "2.3.0", waitMinutes: 0, pollSeconds: 60 },
      context,
    );
    assertEquals(ok.dataHandles.length, 1);
    assertEquals(written[0].passed, true);
    await assertRejects(
      () =>
        model.methods.verify_release.execute(
          { version: "2.4.0", waitMinutes: 0, pollSeconds: 60 },
          context,
        ),
      Error,
      "is not served by WordPress.org",
    );
    assertEquals(written[1].passed, false);
    // an outage records nothing
    globalThis.fetch = (() =>
      Promise.resolve(new Response("busy", { status: 503 }))) as typeof fetch;
    await assertRejects(
      () =>
        model.methods.verify_release.execute(
          { version: "2.3.0", waitMinutes: 0, pollSeconds: 60 },
          context,
        ),
      Error,
      "could not be read",
    );
    assertEquals(written.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Added after the round-3 reviews.

Deno.test("clean also removes bidi, zero-width and line-separator characters", () => {
  assertEquals(
    clean("A‮gnp.exe NEXT ​﻿⁦x⁩"),
    "A gnp.exe NEXT x",
  );
});

Deno.test("token keeps only a version-like first word", () => {
  assertEquals(token("2.3.0"), "2.3.0");
  assertEquals(token("  2.3.0 <!-- note -->"), "2.3.0");
  assertEquals(token("trunk"), "trunk");
  assertEquals(token("20260901"), "20260901");
  assertEquals(token("Trunk"), "trunk");
  assertEquals(token("1.0.0_beta~2"), "1.0.0_beta~2");
  assertEquals(token("www.example.com"), null);
  assertEquals(token("v2.3.0"), null);
  assertEquals(token("bit.ly"), null);
  assertEquals(token("1.0.0-beta.1"), "1.0.0-beta.1");
  assertEquals(token("<!channel> [rotate keys](https://example.com/x)"), null);
  assertEquals(token("<script>alert(1)</script>"), null);
  assertEquals(token("2.3.0‮0.3.2"), "2.3.0");
  assertEquals(token("1".repeat(41)), null);
  assertEquals(token(""), null);
  assertEquals(token(7), null);
});

Deno.test("decodeName decodes entities and still returns clean text", () => {
  assertEquals(
    decodeName("A &amp; B &#8211; C&#8217;s &#038; &lt;D&gt;"),
    "A & B – C’s & <D>",
  );
  assertEquals(decodeName("x&#10;y&#x202e;z"), "x y z");
  assertEquals(
    decodeName("&#0; &#99999999; &#xD800; &bogus;"),
    "&#0; &#99999999; &#xD800; &bogus;",
  );
  assertEquals(decodeName(null), null);
});

Deno.test("assess: severities and the flags for what could not be read", () => {
  const sev = (over: Record<string, unknown>, max?: number) =>
    assess({ ...LISTING, ...over } as typeof LISTING, 180, max).map((f) =>
      `${f.severity}:${f.code}`
    );
  assertEquals(sev({ supportThreadsUnresolved: 5 }), [
    "info:support_unresolved",
  ]);
  assertEquals(sev({ supportThreadsUnresolved: 6 }), [
    "warn:support_unresolved",
  ]);
  assertEquals(sev({ supportThreadsUnresolved: 1 }, 0), [
    "warn:support_unresolved",
  ]);
  assertEquals(sev({ supportThreadsUnresolved: null }), [
    "info:support_unknown",
  ]);
  assertEquals(sev({ trunkStableTag: null }), ["warn:stable_tag_missing"]);
  assertEquals(sev({ trunkVersion: null }), ["warn:main_file_unread"]);
  assertEquals(sev({ directoryStatus: "not_found" }), ["warn:not_listed"]);
  const closed = assess(
    {
      ...LISTING,
      directoryStatus: "closed",
      closedDate: "2029-01-30",
      closedReason: "Security Issue",
    } as unknown as typeof LISTING,
    180,
  );
  assertEquals(closed[0].severity, "fail");
  assertEquals(
    closed[0].message,
    "Plugin is closed on WordPress.org since 2029-01-30 (Security Issue)",
  );
});

Deno.test("syncListing stores why a plugin was closed", async () => {
  const l = await syncListing(
    G,
    180,
    fake({
      "slug%5D=example-plugin": {
        status: 404,
        body: JSON.stringify({
          error: "closed",
          closed: true,
          closed_date: "2029-01-30",
          reason_text: "Security Issue",
        }),
      },
      "version-check": CORE,
    }).fetcher,
    NOW,
  );
  assertEquals(l.closedDate, "2029-01-30");
  assertEquals(l.closedReason, "Security Issue");
  assertEquals(l.status, "fail");
});

Deno.test("syncListing: only WordPress.org's exact 404 answers count; every other 404 or 'closed' stops the run", async () => {
  const cases: Record<string, Route> = {
    "404 outage text": {
      status: 404,
      body: JSON.stringify({ error: "Service temporarily unavailable" }),
    },
    "404 empty error": { status: 404, body: JSON.stringify({ error: "" }) },
    "404 rate limited": {
      status: 404,
      body: JSON.stringify({ error: "rate limited" }),
    },
    "404 near miss": {
      status: 404,
      body: JSON.stringify({ error: "plugin not found" }),
    },
    "503 closed": { status: 503, body: JSON.stringify({ closed: true }) },
    "200 closed": { body: JSON.stringify({ error: "closed" }) },
    "404 closed flag without the error": {
      status: 404,
      body: JSON.stringify({ closed: true }),
    },
    "200 listing with an error key": info({ error: null }),
  };
  for (const [name, route] of Object.entries(cases)) {
    await assertRejects(
      () =>
        syncListing(
          G,
          180,
          fake(live({ "slug%5D=example-plugin": route })).fetcher,
          NOW,
        ),
      Error,
      "no usable answer",
      name,
    );
  }
});

Deno.test("syncListing never reads 'ok' when SVN is down, serves garbage, or hides the main file", async () => {
  const api = { "slug%5D=example-plugin": info(), "version-check": CORE };
  const expectUnread = async (routes: Routes, name: string) => {
    const l = await syncListing(G, 180, fake(routes).fetcher, NOW);
    assertEquals(l.status, "warn", name);
    assertEquals(
      l.flags.map((f) => f.code),
      ["stable_tag_missing", "main_file_unread"],
      name,
    );
    assertEquals(l.trunkStableTag, null, name);
    assertEquals(l.trunkVersion, null, name);
  };
  // every SVN URL answers 404 (no route)
  await expectUnread(api, "svn 404");
  // SVN answers 200 with a maintenance page for everything
  await expectUnread({
    ...api,
    "plugins.svn.wordpress.org": {
      body: "<html>Maintenance, back soon</html>",
    },
  }, "svn maintenance page");
  // the main file is past the limit and not <slug>.php
  const many = Array.from(
    { length: 30 },
    (_, i) => `<a href="a${String(i).padStart(2, "0")}.php">`,
  ).join("");
  const hidden = await syncListing(
    G,
    180,
    fake({
      ...api,
      "trunk/readme.txt": README,
      "trunk/zz-main.php": {
        body:
          "<?php\n/* Plugin Name: Example\n * Version: 2.3.0\n * WC tested up to: 1.0\n */",
      },
      "example-plugin/trunk/": { body: many + '<a href="zz-main.php">' },
    }).fetcher,
    NOW,
  );
  assertEquals(hidden.status, "warn");
  assertEquals(hidden.flags.map((f) => f.code), ["main_file_unread"]);
  // the header sits after 8 KiB of comments
  const late = await syncListing(
    G,
    180,
    fake(live({
      "trunk/example-plugin.php": {
        body: "<?php\n" + "// licence\n".repeat(900) +
          "/* Plugin Name: Example\n * Version: 2.3.0\n */",
      },
    })).fetcher,
    NOW,
  );
  assertEquals(late.flags.map((f) => f.code), ["main_file_unread"]);
});

Deno.test("syncListing prefers the file with Plugin Name and Version over a helper that only mentions Plugin Name", async () => {
  const l = await syncListing(
    G,
    180,
    fake({
      "slug%5D=example-plugin": info(),
      "version-check": CORE,
      "trunk/readme.txt": README,
      "trunk/aaa-helper.php": {
        body: "<?php\n// Plugin Name: not the main file\n",
      },
      "trunk/main.php": MAIN,
      "example-plugin/trunk/": {
        body: '<a href="aaa-helper.php"><a href="main.php">',
      },
    }).fetcher,
    NOW,
  );
  assertEquals(l.trunkVersion, "2.3.0");
  assertEquals(l.flags, []);
});

Deno.test("syncListing falls back to readme.md, including the markdown header style", async () => {
  const l = await syncListing(
    G,
    180,
    fake({
      "trunk/readme.txt": { status: 404 },
      "trunk/readme.md": { body: "# Example Plugin\n**Stable tag:** 2.3.0\n" },
      "slug%5D=example-plugin": info(),
      "version-check": CORE,
      "trunk/example-plugin.php": MAIN,
      "example-plugin/trunk/": TRUNK,
    }).fetcher,
    NOW,
  );
  assertEquals(l.trunkStableTag, "2.3.0");
  assertEquals(l.flags, []);
});

Deno.test("text a plugin author controls never reaches a stored message", async () => {
  const l = await syncListing(
    G,
    180,
    fake(live({
      "trunk/readme.txt": {
        body:
          "Stable tag: <!channel> [urgent: rotate keys](https://example.com/x)\n",
      },
      "trunk/example-plugin.php": {
        body:
          "<?php\n/* Plugin Name: Example\n * Version: 2.4.0‮0.3.2 ​<script>alert(1)</script>\n * WC tested up to: <img src=x>\n */",
      },
    })).fetcher,
    NOW,
  );
  const stored = JSON.stringify(l);
  for (
    const bad of ["channel", "rotate", "example.com", "script", "<img", "‮", "​"]
  ) {
    assertEquals(stored.includes(bad), false, bad);
  }
  assertEquals(l.trunkStableTag, null);
  assertEquals(l.trunkVersion, "2.4.0");
  assertEquals(l.wcTestedUpTo, null);
  assertEquals(l.flags.map((f) => f.code), [
    "wc_tested_unchecked",
    "stable_tag_missing",
    "trunk_unreleased",
  ]);
});

// The real folder page Subversion on plugins.svn.wordpress.org serves for hello-dolly's tag 1.7.2 (public, recorded 2026-11-19).
const REAL_TAG_PAGE =
  `<html><head><title> - Revision 3812145: /hello-dolly/tags/1.7.2</title></head>
<body>
 <h2> - Revision 3812145: /hello-dolly/tags/1.7.2</h2>
 <ul>
  <li><a href="../">..</a></li>
  <li><a href="hello.php">hello.php</a></li>
  <li><a href="readme.txt">readme.txt</a></li>
 </ul>
 <hr noshade><em>Powered by <a href="http://subversion.apache.org/">Apache Subversion</a> version 1.14.5 (r1922182).</em>
</body></html>`;

Deno.test("verifyOnce: the tag check reads the page title, not any text on the page", async () => {
  const hello = (tagPage: string, version = "1.7.2") =>
    verifyOnce(
      "hello-dolly",
      "1.7.2",
      fake({
        "slug%5D=hello-dolly": {
          body: JSON.stringify({ slug: "hello-dolly", version }),
        },
        "trunk/readme.txt": { body: "Stable tag: 1.7.2\n" },
        "tags/1.7.2/": { body: tagPage },
        "hello-dolly.1.7.2.zip": { body: ZIP },
      }).fetcher,
    );
  assertEquals(failing(await hello(REAL_TAG_PAGE)), []);
  for (
    const page of [
      "<html><title>Maintenance</title><body>see /hello-dolly/tags/1.7.2</title></body></html>",
      "<title> - Revision 1: /hello-dolly/tags/1.7.20</title>",
      "<title> - Revision 1: /other/hello-dolly/tags/1.7.2/x</title>",
      "<title> - Revision 1: /hello-dolly/tags/1x7x2</title>",
      "<p>: /hello-dolly/tags/1.7.2</title>",
      "",
    ]
  ) {
    assertEquals(failing(await hello(page)), ["svn_tag"], page);
  }
});

Deno.test("verifyOnce refuses an answer for another plugin and unclear 404s; a clear 'not found' is a failing check", async () => {
  const run = (route: Route) =>
    verifyOnce(
      "example-plugin",
      "2.3.0",
      fake(served({ "slug%5D=example-plugin": route })).fetcher,
    );
  await assertRejects(
    () => run(info({ slug: "other-plugin" })),
    Error,
    "no usable answer",
  );
  await assertRejects(
    () => run(info({ error: "x" })),
    Error,
    "no usable answer",
  );
  await assertRejects(
    () =>
      run({
        status: 404,
        body: JSON.stringify({ error: "Service temporarily unavailable" }),
      }),
    Error,
    "no usable answer",
  );
  assertEquals(
    failing(
      await run({
        status: 404,
        body: JSON.stringify({ error: "Plugin not found." }),
      }),
    ),
    ["directory_version"],
  );
  // a hostile Stable tag is not echoed into the stored detail
  const checks = await verifyOnce(
    "example-plugin",
    "2.3.0",
    fake(
      served({ "trunk/readme.txt": { body: "Stable tag: <!channel> hi\n" } }),
    ).fetcher,
  );
  assertEquals(
    checks.find((c) => c.code === "trunk_stable_tag")?.detail,
    "trunk Stable tag missing",
  );
});

Deno.test("verifyOnce reads readme.md when there is no readme.txt", async () => {
  assertEquals(
    failing(
      await verifyOnce(
        "example-plugin",
        "2.3.0",
        fake({
          "trunk/readme.md": { body: "**Stable tag:** 2.3.0\n" },
          "slug%5D=example-plugin": info(),
          "tags/2.3.0/": {
            body: "<title> - Revision 1: /example-plugin/tags/2.3.0</title>",
          },
          "example-plugin.2.3.0.zip": { body: ZIP },
        }).fetcher,
      ),
    ),
    [],
  );
});

Deno.test("role is optional and defaults to watch", () => {
  assertEquals(model.globalArguments.parse({ slug: "hello-dolly" }), {
    slug: "hello-dolly",
    role: "watch",
  });
});

// ---------------------------------------------------------------------------
// Added after red team 1's mutation testing: each test below fails when the rule in its name is removed.

/** Runs `fn` with globalThis.fetch replaced, recording every call. */
async function withFetch(
  answer: (url: string) => Response,
  fn: (calls: { url: string; init: RequestInit }[]) => Promise<void>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(answer(String(input)));
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("wporgFetch never follows a redirect, always sets a timeout, sends no credentials and honours cancel", async () => {
  await withFetch(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      }),
    async (calls) => {
      await assertRejects(
        () => wporgFetch("https://api.wordpress.org/x"),
        Error,
        "redirect (302); not followed",
      );
      assertEquals(calls.length, 1);
      assertEquals(calls[0].init.redirect, "manual");
      assertEquals(calls[0].init.signal instanceof AbortSignal, true);
      assertEquals(calls[0].init.method ?? "GET", "GET");
      assertEquals(calls[0].init.body, undefined);
      assertEquals(calls[0].init.credentials, undefined);
      assertEquals(Object.keys(calls[0].init.headers ?? {}), ["user-agent"]);
    },
  );
  assertEquals(REQUEST_TIMEOUT_MS, 30_000);
  await withFetch(() => new Response("ok"), async (calls) => {
    const cancel = new AbortController();
    await wporgFetch("https://api.wordpress.org/x", cancel.signal);
    const signal = calls[0].init.signal as AbortSignal;
    assertEquals(signal.aborted, false);
    cancel.abort(new Error("stop"));
    assertEquals(signal.aborted, true);
  });
});

Deno.test("sleep stops as soon as the run is cancelled", async () => {
  await assertRejects(
    () => sleep(60_000, AbortSignal.abort(new Error("stop"))),
    Error,
    "stop",
  );
  const c = new AbortController();
  const waiting = sleep(60_000, c.signal);
  c.abort(new Error("stop now"));
  await assertRejects(() => waiting, Error, "stop now");
  await sleep(1);
});

/** A 1 MB body served in 1 KiB chunks that counts how much was pulled from it. */
function countedBody(head: string) {
  let sent = 0;
  const first = new TextEncoder().encode(head);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = sent === 0 ? first : new Uint8Array(1024).fill(0x20);
      sent += chunk.length;
      controller.enqueue(chunk);
      if (sent > 1_000_000) controller.close();
    },
  }, { highWaterMark: 0 });
  return { stream, sent: () => sent };
}

Deno.test("syncListing stops reading a readme and a PHP file after the first 8 KiB", async () => {
  const readme = countedBody("Stable tag: 2.3.0\n");
  const main = countedBody(
    "<?php\n/* Plugin Name: Example\n * Version: 2.3.0\n */\n",
  );
  const l = await syncListing(
    G,
    180,
    fake(live({
      "trunk/readme.txt": () => ({
        body: readme.stream as unknown as Uint8Array,
      }),
      "trunk/example-plugin.php": () => ({
        body: main.stream as unknown as Uint8Array,
      }),
    })).fetcher,
    NOW,
  );
  assertEquals(l.flags, []);
  assertEquals(
    readme.sent() <= HEADER_BYTES + 4096,
    true,
    `readme pulled ${readme.sent()}`,
  );
  assertEquals(
    main.sent() <= HEADER_BYTES + 4096,
    true,
    `main file pulled ${main.sent()}`,
  );
  // and a Stable tag that only appears after 8 KiB is not read
  const far = await syncListing(
    G,
    180,
    fake(live({
      "trunk/readme.txt": {
        body: "x".repeat(HEADER_BYTES) + "\nStable tag: 2.3.0\n",
      },
    })).fetcher,
    NOW,
  );
  assertEquals(far.flags.map((f) => f.code), ["stable_tag_missing"]);
});

Deno.test("syncListing: numbers and dates from WordPress.org that make no sense are 'unknown', never stored", async () => {
  const l = await syncListing(
    G,
    180,
    fake(live({
      "slug%5D=example-plugin": info({
        support_threads: 1e308,
        support_threads_resolved: -1e308,
        active_installs: -5,
        rating: 4.5,
        num_ratings: "12",
        last_updated: "9999-12-31 9:37pm GMT",
      }),
    })).fetcher,
    NOW,
  );
  assertEquals(l.supportThreads, null);
  assertEquals(l.supportThreadsUnresolved, null);
  assertEquals(l.activeInstalls, null);
  assertEquals(l.rating, null);
  assertEquals(l.numRatings, null);
  assertEquals(l.daysSinceUpdate, null);
  assertEquals(l.flags.map((f) => f.code), [
    "last_update_unknown",
    "support_unknown",
  ]);
  // more resolved than threads is zero unresolved, not a negative number
  const clamp = await syncListing(
    G,
    180,
    fake(live({
      "slug%5D=example-plugin": info({
        support_threads: 1,
        support_threads_resolved: 3,
      }),
    })).fetcher,
    NOW,
  );
  assertEquals(clamp.supportThreadsUnresolved, 0);
  assertEquals(clamp.flags, []);
});

Deno.test("verifyOnce and pollRelease store only cleaned text", async () => {
  const checks = await verifyOnce(
    "example-plugin",
    "2.3.0",
    fake(served({ "slug%5D=example-plugin": info({ version: "<b>9</b> ‮" }) }))
      .fetcher,
  );
  assertEquals(checks[0], {
    code: "directory_version",
    passed: false,
    detail: "Directory serves nothing",
  });
  const c = clock();
  const r = await pollRelease("example-plugin", "2.3.0", {
    waitMinutes: 0,
    pollSeconds: 60,
  }, {
    fetcher: () =>
      Promise.reject(new Error("boom‮\n\u001b[31mred " + "x".repeat(500))),
    now: c.now,
    wait: c.wait,
  });
  assertEquals(r.error?.startsWith("boom [31mred xxx"), true);
  assertEquals(r.error?.length, 200);
});

Deno.test("verifyOnce: the tag folder of a longer version does not count", async () => {
  const checks = await verifyOnce(
    "example-plugin",
    "2.3.0",
    fake(served({
      "tags/2.3.0/": {
        body: "<title> - Revision 1: /example-plugin/tags/2.3.0.1</title>",
      },
    })).fetcher,
  );
  assertEquals(failing(checks), ["svn_tag"]);
});

Deno.test("repo is owner/name and nothing path-like", () => {
  const ok = (repo: string) =>
    model.globalArguments.safeParse({ slug: "x", repo }).success;
  assertEquals(ok("your-org/hello-dolly"), true);
  assertEquals(ok("a.b/c.d"), true);
  for (
    const bad of ["../..", "./.", "a/..", "../a", "a", "a/b/c", "a/b ", "/a"]
  ) {
    assertEquals(ok(bad), false, bad);
  }
});

Deno.test("sync.execute honours staleDays and maxUnresolved, logs every flag and writes one listing", async () => {
  const { fetcher } = fake(live({
    "slug%5D=example-plugin": info({
      support_threads: 4,
      support_threads_resolved: 1,
      // 30 days before the real clock, which execute uses: stale at staleDays 1, fresh at 3650
      last_updated: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(
        0,
        10,
      ) + " 9:37pm GMT",
    }),
  }));
  await withFetch(() => new Response(""), async () => {
    globalThis.fetch = ((input: URL | string) =>
      fetcher(String(input))) as typeof fetch;
    const run = async (args: { staleDays: number; maxUnresolved: number }) => {
      const written: Record<string, unknown>[] = [];
      const logged: string[] = [];
      const out = await model.methods.sync.execute(args, {
        globalArgs: G,
        logger: {
          info: (msg: string, props?: Record<string, unknown>) =>
            logged.push(
              msg.replace(/\{(\w+)\}/g, (_, k) => String(props?.[k])),
            ),
        },
        writeResource: (
          spec: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push({ spec, name, ...data });
          return Promise.resolve({ name });
        },
      });
      assertEquals(out.dataHandles.length, 1);
      assertEquals(written.length, 1);
      assertEquals(written[0].spec, "listing");
      return {
        listing: written[0] as {
          status: string;
          flags: { code: string; severity: string }[];
        },
        logged,
      };
    };
    // the fixture's last update is far in the past relative to today's real clock
    const strict = await run({ staleDays: 1, maxUnresolved: 0 });
    assertEquals(
      strict.listing.flags.map((f) => `${f.severity}:${f.code}`),
      ["warn:stale", "warn:support_unresolved"],
    );
    assertEquals(strict.logged.length, 3);
    assertStringIncludes(strict.logged[1], "warn stale: Last update");
    assertStringIncludes(
      strict.logged[2],
      "warn support_unresolved: 3 unresolved",
    );
    const loose = await run({ staleDays: 3650, maxUnresolved: 5 });
    assertEquals(
      loose.listing.flags.map((f) => `${f.severity}:${f.code}`),
      ["info:support_unresolved"],
    );
    assertEquals(loose.listing.status, "ok");
  });
});

// ---------------------------------------------------------------------------
// Added after the round-4 verification.

Deno.test("clean removes invisible fillers, variation selectors, private use and lone surrogates, and never cuts a character in half", () => {
  assertEquals(
    clean("aㅤbᅟcﾠd͏e⠀f️g\u{E0101}hi\uD800j"),
    "a b c d e f g h i j",
  );
  const cut = clean("x".repeat(199) + "\u{1F600}\u{1F600}") ?? "";
  assertEquals([...cut].length, 200);
  assertEquals(cut.endsWith("\u{1F600}"), true);
  assertEquals(cut.isWellFormed(), true);
});

Deno.test("syncListing: the WordPress version, the closure date and the closure reason are never stored raw", async () => {
  await assertRejects(
    () =>
      syncListing(
        G,
        180,
        fake(live({
          "version-check": {
            body: JSON.stringify({
              offers: [{
                current:
                  "<a href=http://example.com>8.1</a> [x](http://example.com)",
              }],
            }),
          },
        })).fetcher,
        NOW,
      ),
    Error,
    "current WordPress version",
  );
  const closed = (extra: Record<string, unknown>) =>
    syncListing(
      G,
      180,
      fake({
        "slug%5D=example-plugin": {
          status: 404,
          body: JSON.stringify({ error: "closed", closed: true, ...extra }),
        },
        "version-check": CORE,
      }).fetcher,
      NOW,
    );
  const l = await closed({
    closed_date: "2029-01-30<script>",
    reason_text: "Guideline‮ violation\n\u001b[31m" + "y".repeat(400),
  });
  assertEquals(l.closedDate, null);
  assertEquals(l.closedReason?.startsWith("Guideline violation [31myyy"), true);
  assertEquals([...(l.closedReason ?? "")].length, 200);
  assertEquals(l.flags[0].message.includes("since"), false);
  assertEquals(
    (await closed({ closed_date: 20290130, reason_text: 7 })).closedReason,
    null,
  );
  // near misses of the closed answer are not "closed"
  for (const error of ["Plugin closed.", "Closed", "closed."]) {
    await assertRejects(
      () =>
        syncListing(
          G,
          180,
          fake(live({
            "slug%5D=example-plugin": {
              status: 404,
              body: JSON.stringify({ error }),
            },
          })).fetcher,
          NOW,
        ),
      Error,
      "no usable answer",
      error,
    );
  }
});

Deno.test("syncListing: an unusual but real version is stored, one that is not version-like becomes a flag, never a stop", async () => {
  const run = (version: string) =>
    syncListing(
      G,
      180,
      fake(live({ "slug%5D=example-plugin": info({ version }) })).fetcher,
      NOW,
    );
  const beta = await run("2.3.0_beta");
  assertEquals(beta.version, "2.3.0_beta");
  const odd = await run("version two <b>");
  assertEquals(odd.version, null);
  assertEquals(odd.flags.map((f) => f.code), ["version_unreadable"]);
  assertEquals(odd.status, "warn");
  assertEquals(JSON.stringify(odd).includes("<b>"), false);
});

Deno.test("syncListing: Stable tag 'Trunk' in any case is trunk; a WC header that is not a version is flagged", async () => {
  const trunk = await syncListing(
    G,
    180,
    fake(live({ "trunk/readme.txt": { body: "Stable tag: TRUNK\n" } })).fetcher,
    NOW,
  );
  assertEquals(trunk.trunkStableTag, "trunk");
  assertEquals(trunk.flags.map((f) => f.code), ["stable_tag_trunk"]);
  const wc = await syncListing(
    G,
    180,
    fake({
      "slug%5D=woocommerce": {
        body: JSON.stringify({ slug: "woocommerce", version: "12.4.1" }),
      },
      ...live({
        "trunk/example-plugin.php": {
          body:
            "<?php\n/* Plugin Name: Example\n * Version: 2.3.0\n * WC tested up to: (9.9)\n */",
        },
      }),
    }).fetcher,
    NOW,
  );
  assertEquals(wc.wcDeclared, true);
  assertEquals(wc.wcTestedUpTo, null);
  assertEquals(wc.flags.map((f) => f.code), ["wc_tested_unchecked"]);
  assertEquals(wc.status, "warn");
});

Deno.test("wporgFetch keeps its own timeout when a cancel signal is passed", async () => {
  await withFetch(() => new Response("ok"), async (calls) => {
    const cancel = new AbortController();
    await wporgFetch("https://api.wordpress.org/x", cancel.signal);
    // the request's signal is a combination, not the caller's signal alone
    assertEquals(calls[0].init.signal === cancel.signal, false);
    assertEquals(calls[0].init.signal instanceof AbortSignal, true);
  });
});

/** A context whose cancel signal the test controls; fetch refuses when the signal it was given is aborted. */
function cancellable() {
  const controller = new AbortController();
  const logged: string[] = [];
  const context = {
    globalArgs: G,
    signal: controller.signal,
    logger: {
      info: (msg: string, props?: Record<string, unknown>) => {
        logged.push(msg.replace(/\{(\w+)\}/g, (_, k) => String(props?.[k])));
      },
    },
    writeResource: (_s: string, name: string, _d: Record<string, unknown>) =>
      Promise.resolve({ name }),
  };
  return { controller, context, logged };
}

async function withAbortAwareFetch(routes: Routes, fn: () => Promise<void>) {
  const { fetcher } = fake(routes);
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: URL | string, init?: RequestInit) =>
      init?.signal?.aborted
        ? Promise.reject(new Error("request cancelled"))
        : fetcher(String(input))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("sync.execute and verify_release.execute pass swamp's cancel signal to every request", async () => {
  await withAbortAwareFetch(live(), async () => {
    const ok = cancellable();
    await model.methods.sync.execute(
      { staleDays: 180, maxUnresolved: 5 },
      ok.context,
    );
    const stopped = cancellable();
    stopped.controller.abort();
    await assertRejects(
      () =>
        model.methods.sync.execute(
          { staleDays: 180, maxUnresolved: 5 },
          stopped.context,
        ),
      Error,
      "request cancelled",
    );
  });
  await withAbortAwareFetch(
    served({ "example-plugin/trunk/": TRUNK }),
    async () => {
      const args = { version: "2.3.0", waitMinutes: 0, pollSeconds: 60 };
      const ok = cancellable();
      await model.methods.verify_release.execute(args, ok.context);
      const stopped = cancellable();
      stopped.controller.abort();
      await assertRejects(
        () => model.methods.verify_release.execute(args, stopped.context),
        Error,
        "request cancelled",
      );
    },
  );
});

Deno.test("verify_release.execute stops waiting between polls as soon as the run is cancelled", async () => {
  await withAbortAwareFetch(served(), async () => {
    const run = cancellable();
    // cancel right after the first attempt is logged, while the method starts its 30 minute wait
    run.context.logger.info = (msg: string) => {
      if (msg.includes("attempt")) {
        queueMicrotask(() =>
          run.controller.abort(new Error("cancelled by swamp"))
        );
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("still waiting after 2 s")),
        2000,
      );
    });
    try {
      await assertRejects(
        () =>
          Promise.race([
            model.methods.verify_release.execute(
              { version: "2.4.0", waitMinutes: 120, pollSeconds: 1800 },
              run.context,
            ),
            tooSlow,
          ]),
        Error,
        "cancelled by swamp",
      );
    } finally {
      clearTimeout(timer);
    }
  });
});

Deno.test("syncListing keeps only the version from a WordPress core answer that has text after it", async () => {
  const l = await syncListing(
    G,
    180,
    fake(live({
      "version-check": {
        body: JSON.stringify({
          offers: [{ current: "8.1 <a href=http://example.com>click</a>" }],
        }),
      },
    })).fetcher,
    NOW,
  );
  assertEquals(l.wpLatest, "8.1");
  assertEquals(JSON.stringify(l).includes("example.com"), false);
});

// ---------------------------------------------------------------------------
// Added after Grok's fix-verification.

Deno.test("wporgFetch uses a real 30 second timeout signal, alone or combined with cancel", async () => {
  const asked: number[] = [];
  const made: AbortController[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    asked.push(ms);
    const c = new AbortController();
    made.push(c);
    return c.signal;
  };
  try {
    await withFetch(() => new Response("ok"), async (calls) => {
      await wporgFetch("https://api.wordpress.org/x");
      assertEquals(asked, [30_000]);
      // without cancel, the request's signal IS the timeout signal
      assertEquals(calls[0].init.signal === made[0].signal, true);
      const cancel = new AbortController();
      await wporgFetch("https://api.wordpress.org/x", cancel.signal);
      assertEquals(asked, [30_000, 30_000]);
      // with cancel, the timeout still aborts the request
      const signal = calls[1].init.signal as AbortSignal;
      assertEquals(signal.aborted, false);
      made[1].abort();
      assertEquals(signal.aborted, true);
    });
  } finally {
    AbortSignal.timeout = original;
  }
});

Deno.test("syncListing: a cancelled run stops at the WooCommerce lookup; a failed lookup alone is only a flag", async () => {
  const wcMain = {
    body:
      "<?php\n/* Plugin Name: Example\n * Version: 2.3.0\n * WC tested up to: 12.4\n */",
  };
  const cancel = new AbortController();
  const { fetcher } = fake(live({ "trunk/example-plugin.php": wcMain }));
  const failing = (url: string) => {
    if (!url.includes("slug%5D=woocommerce")) return fetcher(url);
    cancel.abort(new Error("cancelled by swamp"));
    return Promise.reject(new Error("request cancelled"));
  };
  await assertRejects(
    () => syncListing(G, 180, failing, NOW, 5, cancel.signal),
    Error,
    "request cancelled",
  );
  // the same failure without a cancel is a flag
  const l = await syncListing(
    G,
    180,
    (url) =>
      url.includes("slug%5D=woocommerce")
        ? Promise.reject(new Error("timed out"))
        : fetcher(url),
    NOW,
    5,
    new AbortController().signal,
  );
  assertEquals(l.flags.map((f) => f.code), ["wc_tested_unchecked"]);
});

Deno.test("syncListing: an update stamped a little ahead of the local clock is today, not unknown", async () => {
  const at = (last_updated: string) =>
    syncListing(
      G,
      180,
      fake(live({ "slug%5D=example-plugin": info({ last_updated }) })).fetcher,
      NOW,
    );
  // NOW is 2030-06-01 00:00 UTC
  assertEquals((await at("2030-06-01 12:05am GMT")).daysSinceUpdate, 0);
  assertEquals((await at("2030-06-01 11:59pm GMT")).daysSinceUpdate, 0);
  assertEquals((await at("2030-06-03 12:05am GMT")).daysSinceUpdate, null);
});
