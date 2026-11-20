import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  BodyTooLarge,
  call,
  clean,
  CLOCK_SKEW_MS,
  createBackup,
  holdsKey,
  hostName,
  KEY,
  KEY_FRAGMENT,
  kinstaFetch,
  LIMIT_RETRIES,
  listBackups,
  listSites,
  MAX_BACKUPS,
  MAX_BODY_BYTES,
  MAX_ENVIRONMENTS,
  MAX_LABELS,
  MAX_RETRY_AFTER_MS,
  MAX_SITES,
  MAX_VALUE_CHARS,
  MAYBE_STARTED,
  model,
  newBackup,
  READ_RETRIES,
  readBackup,
  readBody,
  readEnvironment,
  readSite,
  reason,
  recentWithTag,
  refusal,
  REQUEST_TIMEOUT_MS,
  requestSignal,
  retryAfterMs,
  safeText,
  scrub,
  sleep,
  TAG,
  UUID,
  versionWord,
} from "./kinsta.ts";

// Everything below is made up: no id, name, domain or key here belongs to a real account.
const FAKE_KEY = "kinsta-test-key-0123456789abcdef-not-real";
const COMPANY = "1111aaaa-1111-4111-8111-111111111111";
const SITE = "2222bbbb-2222-4222-8222-222222222222";
const ENV = "3333cccc-3333-4333-8333-333333333333";
const ENV2 = "4444dddd-4444-4444-8444-444444444444";
const NOW = Date.parse("2030-06-01T12:00:00Z");
const API = "https://api.kinsta.com/v2";

type Req = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};
type Route = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};
/** A fake Kinsta: `answer` gets each request and how many came before it. Records every request. */
function fake(answer: (req: Req, n: number) => Route | Error) {
  const asked: Req[] = [];
  const fetcher = (url: string, init: Omit<Req, "url">) => {
    const req = { url, ...init };
    const r = answer(req, asked.length);
    asked.push(req);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(
      new Response(
        typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}),
        { status: r.status ?? 200, headers: r.headers },
      ),
    );
  };
  return { fetcher, asked };
}
const noWait = () => Promise.resolve();

const envJson = (over: Record<string, unknown> = {}) => ({
  id: ENV,
  name: "live",
  display_name: "Live",
  is_premium: false,
  is_blocked: false,
  id_edge_cache: "5555eeee-0a0a-4555-8555-5555eeee0a0a",
  cdn_cache_id: "6666ffff-0b0b-4666-8666-6666ffff0b0b",
  is_opt_out_from_automatic_php_update: false,
  web_root: "/www/examplesite_123/public",
  image_optimization_type: "off",
  wordpress_version: "6.8.3",
  domains: [
    { id: "d1", name: "example.com", type: "live" },
    { id: "d2", name: "examplesite.hosting.example", type: "system" },
  ],
  primaryDomain: { id: "d1", name: "Example.com", type: "live" },
  ssh_connection: { ssh_port: "12345", ssh_ip: { external_ip: "192.0.2.10" } },
  container_info: {
    id: "7777abab-0c0c-4777-8777-7777abab0c0c",
    php_engine_version: "php8.3",
  },
  ...over,
});
const siteJson = (over: Record<string, unknown> = {}) => ({
  id: SITE,
  name: "examplesite",
  display_name: "Example Site",
  status: "live",
  site_labels: [{ id: 1, name: "shop" }],
  environments: [envJson(), envJson({ id: ENV2, name: "staging" })],
  ...over,
});
const sitesJson = (sites: unknown[] = [siteJson()]) => ({
  company: { sites },
});
const backupJson = (
  id: number,
  note: string,
  type = "manual",
  created = NOW - 3600_000,
) => ({ id, name: `backup-${id}`, note, type, created_at: created });
const backupsJson = (backups: unknown[]) => ({
  environment: { display_name: "Live", backups },
});

const ARGS = {
  environmentId: ENV,
  tag: "before-update",
  waitMinutes: 15,
  pollSeconds: 15,
  manualLimit: 5,
  whenFull: "refuse" as const,
  reuseWithinMinutes: 15,
};

// ---------------------------------------------------------------- patterns

Deno.test("UUID accepts a lowercase UUID only", () => {
  assert(UUID.test(ENV));
  for (
    const bad of [
      "",
      ENV.toUpperCase(),
      ENV + "\n",
      ` ${ENV}`,
      ENV.slice(1),
      `${ENV}/backups`,
      "../../operations",
      "not-a-uuid",
    ]
  ) {
    assert(!UUID.test(bad), bad);
  }
});

Deno.test("TAG accepts lowercase words joined by single hyphens only", () => {
  for (const ok of ["a", "before-update", "wp-6-8-3", "x1"]) {
    assert(TAG.test(ok), ok);
  }
  for (
    const bad of [
      "",
      "-a",
      "a-",
      "a--b",
      "A",
      "a b",
      "a_b",
      "a\n",
      "a/b",
      'a"b',
      "ä",
    ]
  ) {
    assert(!TAG.test(bad), bad);
  }
});

Deno.test("KEY refuses anything that could break out of a header", () => {
  assert(KEY.test(FAKE_KEY));
  for (
    const bad of [
      "short",
      "a".repeat(15),
      "a".repeat(513),
      `${FAKE_KEY}\r\nx-evil: 1`,
      `${FAKE_KEY} `,
      `key with spaces in it 0123456789`,
      "é".repeat(20),
      "",
    ]
  ) {
    assert(!KEY.test(bad), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- text helpers

Deno.test("clean keeps one line of at most 200 characters and drops invisible characters", () => {
  assertEquals(clean("  a\r\n b\t c  "), "a b c");
  assertEquals(clean("a‮b​c\u0000d"), "a b c d");
  assertEquals(clean("x".repeat(500))!.length, 200);
  assertEquals(clean(""), null);
  assertEquals(clean("​​"), null);
  assertEquals(clean(12), null);
  assertEquals(clean(null), null);
  assertEquals(clean({ toString: () => "x" }), null);
  // a cut never splits a character
  assertEquals([...clean("😀".repeat(300))!].length, 200);
});

Deno.test("hostName keeps a host name and nothing else", () => {
  assertEquals(hostName("Example.com"), "example.com");
  assertEquals(
    hostName("examplesite.hosting.example"),
    "examplesite.hosting.example",
  );
  for (
    const bad of [
      "",
      "localhost",
      "example.com/path",
      "https://example.com",
      "a b.com",
      "example.com\nx",
      "<script>.com",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(130)}com`,
      12,
      null,
      undefined,
    ]
  ) {
    assertEquals(hostName(bad), null, String(bad));
  }
});

Deno.test("versionWord keeps a version-like first word only", () => {
  assertEquals(versionWord("6.8.3"), "6.8.3");
  assertEquals(versionWord("php8.3"), "php8.3");
  assertEquals(versionWord("8.3 (deprecated)"), "8.3");
  for (
    const bad of [
      "",
      "<b>",
      ".1",
      "a".repeat(41),
      "see https://x.example",
      7,
      null,
    ]
  ) {
    assertEquals(
      versionWord(bad),
      bad === "see https://x.example" ? "see" : null,
    );
  }
});

Deno.test("scrub removes every copy of the key and leaves other text alone", () => {
  assertEquals(
    scrub(`a ${FAKE_KEY} b Bearer ${FAKE_KEY}`, FAKE_KEY),
    "a [api key] b Bearer [api key]",
  );
  assertEquals(scrub("nothing here", FAKE_KEY), "nothing here");
  assertEquals(scrub("with an empty key", ""), "with an empty key");
});

Deno.test("reason removes the key before the text is cut", () => {
  // the key straddles the 200 character cut: no part of it may survive
  const msg = "x".repeat(180) + FAKE_KEY + " tail";
  const out = reason(new Error(msg), FAKE_KEY);
  assert(!out.includes(FAKE_KEY.slice(0, 12)), out);
  assertStringIncludes(out, "[api key]");
  assertEquals(reason("plain", FAKE_KEY), "plain");
  assertEquals(reason(new Error(""), FAKE_KEY), "unknown error");
  assertEquals(reason(new Error("two\nlines"), FAKE_KEY), "two lines");
});

Deno.test("refusal gives the status and Kinsta's message, never the key", () => {
  const e = refusal("list things", {
    status: 404,
    body: { status: 404, message: "The requested company was not found!" },
  }, FAKE_KEY);
  assertEquals(
    e.message,
    "Kinsta did not list things (HTTP 404): The requested company was not found!",
  );
  const echoed = refusal("list things", {
    status: 400,
    body: { message: "x".repeat(180) + FAKE_KEY },
  }, FAKE_KEY);
  assert(!echoed.message.includes(FAKE_KEY.slice(0, 12)), echoed.message);
  const unauth = refusal("list things", {
    status: 401,
    body: { error: "Invalid API key!" },
  }, FAKE_KEY);
  assertStringIncludes(unauth.message, "(HTTP 401): Invalid API key!");
  assertStringIncludes(unauth.message, "(check the key in your vault");
  assertEquals(
    refusal("list things", { status: 500, body: { message: 7 } }, FAKE_KEY)
      .message,
    "Kinsta did not list things (HTTP 500)",
  );
  assertEquals(
    refusal("x", { status: 400, body: { message: "a\nb‮c" } }, FAKE_KEY)
      .message,
    "Kinsta did not x (HTTP 400): a bc",
  );
});

Deno.test("retryAfterMs reads whole seconds, with a floor, a ceiling and a default", () => {
  const r = (v?: string) =>
    retryAfterMs(
      new Response("", {
        headers: v === undefined ? {} : { "retry-after": v },
      }),
    );
  assertEquals(r("7"), 7000);
  assertEquals(r("0"), 1000);
  assertEquals(r("999999"), MAX_RETRY_AFTER_MS);
  assertEquals(r(), 5000);
  assertEquals(r("soon"), 5000);
  assertEquals(r("-5"), 5000);
  assertEquals(r("1e9"), 5000);
  assertEquals(r("Wed, 21 Oct 2030 07:28:00 GMT"), 5000);
});

Deno.test("readBody reads up to the cap and throws past it", async () => {
  assertEquals(await readBody(new Response("hello"), 5), "hello");
  await assertRejects(
    () => readBody(new Response("hello!"), 5),
    Error,
    "larger than 5 bytes",
  );
  assertEquals(await readBody(new Response(null), 5), "");
  // a body of many chunks is put back together in order
  const chunks = ["ab", "cd", "ef"].map((s) => new TextEncoder().encode(s));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
  assertEquals(await readBody(new Response(stream), 6), "abcdef");
});

Deno.test("sleep resolves after the time and rejects on abort", async () => {
  await sleep(1);
  const done = new AbortController();
  done.abort(new Error("stop"));
  await assertRejects(() => sleep(10_000, done.signal), Error, "stop");
  const later = new AbortController();
  const p = sleep(10_000, later.signal);
  later.abort(new Error("stop later"));
  await assertRejects(() => p, Error, "stop later");
});

// ---------------------------------------------------------------- kinstaFetch

const GET = { method: "GET" as const, headers: {} };

Deno.test("kinstaFetch refuses every URL that is not the Kinsta API over https", async () => {
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (() => {
    called++;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  try {
    for (
      const url of [
        "http://api.kinsta.com/v2/sites",
        "https://api.kinsta.com.evil.example/v2/sites",
        "https://evil.example/v2/sites",
        "https://api.kinsta.com:8443/v2/sites",
        "https://user:pw@api.kinsta.com/v2/sites",
        "https://api.kinsta.com@evil.example/v2/sites",
        "https://api.kinsta.com/v1/sites",
        "https://api.kinsta.com/",
        "https://169.254.169.254/v2/sites",
        "https://my.kinsta.com/v2/sites",
      ]
    ) {
      await assertRejects(
        () => kinstaFetch(url, GET),
        Error,
        "outside the Kinsta API",
        url,
      );
    }
    assertEquals(called, 0);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("kinstaFetch sends the request as given, never follows a redirect, and has a timeout", async () => {
  const real = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  let next: Response = new Response("{}");
  globalThis.fetch = ((url: URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return Promise.resolve(next);
  }) as typeof fetch;
  try {
    const res = await kinstaFetch(`${API}/sites?company=${COMPANY}`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_KEY}` },
      body: '{"tag":"x"}',
    });
    assertEquals(res.status, 200);
    assertEquals(seen[0].url, `${API}/sites?company=${COMPANY}`);
    assertEquals(seen[0].init.method, "POST");
    assertEquals(seen[0].init.body, '{"tag":"x"}');
    assertEquals(seen[0].init.redirect, "manual");
    assert(seen[0].init.signal instanceof AbortSignal);
    const h = seen[0].init.headers as Record<string, string>;
    assertEquals(h.authorization, `Bearer ${FAKE_KEY}`);
    assertStringIncludes(h["user-agent"], "swamp-kinsta");
    assertEquals(REQUEST_TIMEOUT_MS, 30_000);

    for (const status of [301, 302, 303, 307, 308]) {
      next = new Response(null, {
        status,
        headers: { location: "https://evil.example/" },
      });
      await assertRejects(
        () => kinstaFetch(`${API}/sites`, GET),
        Error,
        `redirect (${status}); not followed`,
      );
    }
    // an already cancelled run never reaches a request that completes
    const stop = new AbortController();
    stop.abort(new Error("cancelled"));
    globalThis.fetch = ((_u: URL, init: RequestInit) =>
      init.signal?.aborted
        ? Promise.reject(init.signal.reason)
        : Promise.resolve(new Response("{}"))) as typeof fetch;
    await assertRejects(
      () =>
        kinstaFetch(`${API}/sites`, GET, stop.signal),
      Error,
      "cancelled",
    );
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------------------------------------------------------- call

Deno.test("call sends the key only in the Authorization header", async () => {
  const k = fake(() => ({ body: { ok: true } }));
  const a = await call(FAKE_KEY, "GET", "/sites?company=x", {
    fetcher: k.fetcher,
  });
  assertEquals(a, { status: 200, body: { ok: true } });
  assertEquals(k.asked.length, 1);
  assertEquals(k.asked[0].url, `${API}/sites?company=x`);
  assert(!k.asked[0].url.includes(FAKE_KEY));
  assertEquals(k.asked[0].headers, {
    authorization: `Bearer ${FAKE_KEY}`,
    accept: "application/json",
  });
  assertEquals(k.asked[0].body, undefined);

  const p = fake(() => ({ status: 202, body: { operation_id: "op" } }));
  await call(FAKE_KEY, "POST", "/x", { fetcher: p.fetcher }, { tag: "t" });
  assertEquals(p.asked[0].method, "POST");
  assertEquals(p.asked[0].body, '{"tag":"t"}');
  assertEquals(p.asked[0].headers["content-type"], "application/json");
  assert(!p.asked[0].body!.includes(FAKE_KEY));
});

Deno.test("call repeats a failed read, then hands back what Kinsta said", async () => {
  const waits: number[] = [];
  const wait = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const k = fake((_r, n) =>
    n < READ_RETRIES ? { status: 503, body: "busy" } : { body: { ok: 1 } }
  );
  assertEquals(
    (await call(FAKE_KEY, "GET", "/x", { fetcher: k.fetcher, wait })).body,
    { ok: 1 },
  );
  assertEquals(k.asked.length, READ_RETRIES + 1);
  assertEquals(waits, [2000, 4000]);

  // still failing after the retries: the last answer comes back, it is not retried for ever
  const down = fake(() => ({ status: 500, body: { message: "down" } }));
  const a = await call(FAKE_KEY, "GET", "/x", {
    fetcher: down.fetcher,
    wait: noWait,
  });
  assertEquals(a.status, 500);
  assertEquals(down.asked.length, READ_RETRIES + 1);

  // a network error on a read is retried too, then reported without the key
  const net = fake(() => new Error(`connect failed ${FAKE_KEY}`));
  const e = await assertRejects(
    () => call(FAKE_KEY, "GET", "/x", { fetcher: net.fetcher, wait: noWait }),
    Error,
    "Kinsta could not be reached",
  );
  assert(!e.message.includes(FAKE_KEY), e.message);
  assertEquals(net.asked.length, READ_RETRIES + 1);
});

Deno.test("call never repeats a write after a network error or a 5xx", async () => {
  const net = fake(() => new Error("reset"));
  await assertRejects(
    () =>
      call(FAKE_KEY, "POST", "/x", { fetcher: net.fetcher, wait: noWait }, {
        tag: "t",
      }),
    Error,
    "Kinsta could not be reached: reset",
  );
  assertEquals(net.asked.length, 1);

  const five = fake(() => ({ status: 502, body: { message: "bad gateway" } }));
  const a = await call(
    FAKE_KEY,
    "POST",
    "/x",
    { fetcher: five.fetcher, wait: noWait },
    { tag: "t" },
  );
  assertEquals(a.status, 502);
  assertEquals(five.asked.length, 1);
});

Deno.test("call waits out a 429 on a read, three times at most", async () => {
  const waits: number[] = [];
  const k = fake((_r, n) =>
    n < 2
      ? { status: 429, body: {}, headers: { "retry-after": "3" } }
      : { status: 200, body: { ok: 1 } }
  );
  const a = await call(FAKE_KEY, "GET", "/x", {
    fetcher: k.fetcher,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(a.status, 200);
  assertEquals(waits, [3000, 3000]);
  assertEquals(k.asked.length, 3);

  const always = fake(() => ({
    status: 429,
    body: { message: "slow down" },
    headers: { "retry-after": "999999" },
  }));
  const all: number[] = [];
  const b = await call(FAKE_KEY, "GET", "/x", {
    fetcher: always.fetcher,
    wait: (ms) => {
      all.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(b.status, 429);
  // the numbers the README gives: three waits, 60 seconds each at most
  assertEquals(always.asked.length, 4);
  assertEquals(all, [60_000, 60_000, 60_000]);
});

Deno.test("call sends a write exactly once, also when Kinsta says too many requests", async () => {
  const waits: number[] = [];
  const k = fake(() => ({
    status: 429,
    body: { message: "slow down" },
    headers: { "retry-after": "1" },
  }));
  const a = await call(FAKE_KEY, "POST", "/x", {
    fetcher: k.fetcher,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  }, { tag: "t" });
  assertEquals(a.status, 429);
  assertEquals(k.asked.length, 1);
  assertEquals(waits, []);
});

Deno.test("the limits the README names are the limits in the code", () => {
  assertEquals(READ_RETRIES, 2);
  assertEquals(LIMIT_RETRIES, 3);
  assertEquals(MAX_RETRY_AFTER_MS, 60_000);
  assertEquals(MAX_BODY_BYTES, 10_000_000);
  assertEquals(REQUEST_TIMEOUT_MS, 30_000);
  assertEquals(CLOCK_SKEW_MS, 300_000);
  assertEquals(MAX_VALUE_CHARS, 200);
  assertEquals(MAX_SITES, 5000);
  assertEquals(MAX_ENVIRONMENTS, 100);
  assertEquals(MAX_LABELS, 100);
  assertEquals(MAX_BACKUPS, 2000);
  assertEquals(KEY_FRAGMENT, 8);
});

Deno.test("call repeats a read after a network error with a growing pause, and after an answer that breaks off", async () => {
  const waits: number[] = [];
  const net = fake((_r, n) => n < 2 ? new Error("reset") : { body: { ok: 1 } });
  await call(FAKE_KEY, "GET", "/x", {
    fetcher: net.fetcher,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(waits, [2000, 4000]);

  let n = 0;
  const broken = () => {
    n++;
    if (n > 1) return Promise.resolve(new Response('{"ok":2}'));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"ok"'));
        c.error(new Error("connection reset mid-body"));
      },
    });
    return Promise.resolve(new Response(body));
  };
  const a = await call(FAKE_KEY, "GET", "/x", {
    fetcher: broken,
    wait: noWait,
  });
  assertEquals(a.body, { ok: 2 });
  assertEquals(n, 2);

  // a write whose answer breaks off is not sent again
  let posts = 0;
  const brokenPost = () => {
    posts++;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("connection reset mid-body"));
      },
    });
    return Promise.resolve(new Response(body, { status: 202 }));
  };
  await assertRejects(
    () =>
      call(FAKE_KEY, "POST", "/x", { fetcher: brokenPost, wait: noWait }, {
        tag: "t",
      }),
    Error,
    "Kinsta could not be reached: connection reset mid-body",
  );
  assertEquals(posts, 1);
});

Deno.test("call never passes on raw error text: not the parser's, not on cancel, not when too large", async () => {
  // a body that is not JSON and holds the start of the key: the parser would quote it
  const echo = fake(() => ({ body: FAKE_KEY.slice(0, 20) }));
  const e = await assertRejects(() =>
    call(FAKE_KEY, "GET", "/x", { fetcher: echo.fetcher, wait: noWait })
  );
  assertEquals(
    (e as Error).message,
    "Kinsta returned HTTP 200 with a body that is not JSON",
  );
  const quoted = fake(() => ({ body: `{"message": ${FAKE_KEY}}` }));
  const q = await assertRejects(() =>
    call(FAKE_KEY, "GET", "/x", { fetcher: quoted.fetcher, wait: noWait })
  );
  assert(!(q as Error).message.includes(FAKE_KEY.slice(0, 8)));

  // a cancelled run: the error that comes out is scrubbed like every other
  const stop = new AbortController();
  stop.abort(new Error("cancelled"));
  for (const method of ["GET", "POST"] as const) {
    const raw = fake(() =>
      new Error(`Invalid header value: "Bearer ${FAKE_KEY}"`)
    );
    const c = await assertRejects(() =>
      call(FAKE_KEY, method, "/x", {
        fetcher: raw.fetcher,
        wait: noWait,
        cancel: stop.signal,
      })
    );
    assertEquals(
      (c as Error).message,
      'cancelled: Invalid header value: "Bearer [api key]"',
    );
    assertEquals(raw.asked.length, 1);
  }

  const big = fake(() => ({ body: "x".repeat(MAX_BODY_BYTES + 1) }));
  const b = await assertRejects(() =>
    call(FAKE_KEY, "GET", "/x", { fetcher: big.fetcher, wait: noWait })
  );
  assert(b instanceof BodyTooLarge);
  // too large is not a network failure: it is not asked for again
  assertEquals(big.asked.length, 1);
});

Deno.test("call throws on a body that is not a JSON object", async () => {
  for (
    const body of ["<html>oops</html>", "[1,2]", "null", '"text"', "7", ""]
  ) {
    const k = fake(() => ({ body }));
    await assertRejects(
      () => call(FAKE_KEY, "GET", "/x", { fetcher: k.fetcher, wait: noWait }),
      Error,
      "Kinsta returned HTTP 200 with a body that is not",
      body,
    );
  }
  const big = fake(() => ({ body: `{"a":"${"x".repeat(MAX_BODY_BYTES)}"}` }));
  await assertRejects(
    () => call(FAKE_KEY, "GET", "/x", { fetcher: big.fetcher }),
    Error,
    "larger than",
  );
});

Deno.test("call stops at once when the run is cancelled", async () => {
  const stop = new AbortController();
  const k = fake(() => {
    stop.abort(new Error("cancelled by the operator"));
    return new Error("aborted");
  });
  await assertRejects(
    () =>
      call(FAKE_KEY, "GET", "/x", {
        fetcher: k.fetcher,
        wait: noWait,
        cancel: stop.signal,
      }),
    Error,
    "aborted",
  );
  assertEquals(k.asked.length, 1);
});

// ---------------------------------------------------------------- sites

Deno.test("readEnvironment keeps a short list of fields and drops the rest", () => {
  const e = readEnvironment(envJson());
  assertEquals(e, {
    id: ENV,
    name: "live",
    displayName: "Live",
    isPremium: false,
    isBlocked: false,
    primaryDomain: "example.com",
    wordpressVersion: "6.8.3",
    phpVersion: "php8.3",
  });
  const text = JSON.stringify(e);
  for (
    const dropped of [
      "192.0.2.10",
      "12345",
      "/www/",
      "5555eeee",
      "6666ffff",
      "7777abab",
      "hosting.example",
    ]
  ) {
    assert(!text.includes(dropped), dropped);
  }
  assertEquals(
    readEnvironment({ id: ENV, is_blocked: "yes", primaryDomain: "x" }),
    {
      id: ENV,
      name: null,
      displayName: null,
      isPremium: null,
      isBlocked: null,
      primaryDomain: null,
      wordpressVersion: null,
      phpVersion: null,
    },
  );
  for (const bad of [null, [], "x", {}, { id: 7 }, { id: "nope" }]) {
    assertThrows(() => readEnvironment(bad), Error, "without a usable id");
  }
});

Deno.test("readSite reads labels and environments and refuses a broken entry", () => {
  const s = readSite(siteJson());
  assertEquals(s.id, SITE);
  assertEquals(s.name, "examplesite");
  assertEquals(s.displayName, "Example Site");
  assertEquals(s.status, "live");
  assertEquals(s.labels, ["shop"]);
  assertEquals(s.environments.map((e) => e.id), [ENV, ENV2]);
  // no environment list (the plain site list) reads as none
  assertEquals(readSite({ id: SITE }).environments, []);
  assertEquals(
    readSite({ id: SITE, site_labels: [{ name: 3 }, null, { name: " a " }] })
      .labels,
    ["a"],
  );
  assertThrows(() => readSite({ id: "x" }), Error, "site without a usable id");
  assertThrows(
    () => readSite({ id: SITE, environments: "none" }),
    Error,
    "environment list",
  );
  assertThrows(
    () => readSite({ id: SITE, environments: [{ id: "bad" }] }),
    Error,
    "environment without a usable id",
  );
  assertThrows(
    () =>
      readSite({
        id: SITE,
        environments: Array(MAX_ENVIRONMENTS + 1).fill(envJson()),
      }),
    Error,
    "environment list",
  );
  assertThrows(
    () => readSite({ id: SITE, site_labels: Array(101).fill({ name: "a" }) }),
    Error,
    "labels",
  );
});

Deno.test("listSites asks once, with the company id, and maps the answer", async () => {
  const k = fake(() => ({ body: sitesJson() }));
  const sites = await listSites(FAKE_KEY, COMPANY, { fetcher: k.fetcher });
  assertEquals(k.asked.length, 1);
  assertEquals(k.asked[0].method, "GET");
  assertEquals(
    k.asked[0].url,
    `${API}/sites?company=${COMPANY}&include_environments=true`,
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0].environments[1].name, "staging");
  assert(!JSON.stringify(sites).includes("192.0.2.10"));
  assertEquals(
    await listSites(FAKE_KEY, COMPANY, {
      fetcher: fake(() => ({ body: sitesJson([]) })).fetcher,
    }),
    [],
  );
});

Deno.test("listSites fails closed on every answer that is not the list", async () => {
  const run = (r: Route) =>
    listSites(FAKE_KEY, COMPANY, {
      fetcher: fake(() => r).fetcher,
      wait: noWait,
    });
  await assertRejects(
    () =>
      run({
        status: 404,
        body: { status: 404, message: "The requested company was not found!" },
      }),
    Error,
    "Kinsta did not list the company's sites (HTTP 404): The requested company was not found!",
  );
  const unauth = await assertRejects(
    () => run({ status: 401, body: { error: "Invalid API key!" } }),
    Error,
    "(HTTP 401): Invalid API key!",
  );
  assert(!unauth.message.includes(FAKE_KEY));
  await assertRejects(() => run({ status: 500, body: {} }), Error, "HTTP 500");
  for (
    const body of [
      {},
      { company: {} },
      { company: { sites: "x" } },
      { company: [] },
      { sites: [] },
    ]
  ) {
    await assertRejects(() => run({ body }), Error, "no site list");
  }
  await assertRejects(
    () => run({ body: sitesJson(Array(MAX_SITES + 1).fill({ id: SITE })) }),
    Error,
    "no site list",
  );
  await assertRejects(
    () => run({ body: sitesJson([{ id: "bad" }]) }),
    Error,
    "site without a usable id",
  );
  // a company id that is not a UUID never reaches the network
  const k = fake(() => ({ body: sitesJson() }));
  await assertRejects(
    () => listSites(FAKE_KEY, "x&company=other", { fetcher: k.fetcher }),
    Error,
    "not a UUID",
  );
  assertEquals(k.asked.length, 0);
});

// ---------------------------------------------------------------- backups

Deno.test("readBackup keeps id, name, note, type and a millisecond time", () => {
  assertEquals(readBackup(backupJson(7, "before-update")), {
    id: 7,
    name: "backup-7",
    note: "before-update",
    type: "manual",
    createdAt: new Date(NOW - 3600_000).toISOString(),
    createdAtMs: NOW - 3600_000,
  });
  // seconds, a string, a fraction, a far future number: all "unknown", never a wrong date
  for (const t of [1_900_000_000, "1900000000000", 1.9e12 + 0.5, 9e15, -1]) {
    const b = readBackup({ id: 7, created_at: t });
    assertEquals(b.createdAt, null);
    assertEquals(b.createdAtMs, null);
  }
  for (
    const bad of [null, {}, { id: "7" }, { id: 0 }, { id: -1 }, { id: 1.5 }, {
      id: 2 ** 60,
    }]
  ) {
    assertThrows(() => readBackup(bad), Error, "backup without a usable id");
  }
});

Deno.test("listBackups asks once for that environment and fails closed", async () => {
  const k = fake(() => ({
    body: backupsJson([
      backupJson(1, "Daily Auto Backup", "autodaily"),
      backupJson(2, "before-update"),
    ]),
  }));
  const r = await listBackups(FAKE_KEY, ENV, { fetcher: k.fetcher });
  assertEquals(k.asked.length, 1);
  assertEquals(k.asked[0].method, "GET");
  assertEquals(k.asked[0].url, `${API}/sites/environments/${ENV}/backups`);
  assertEquals(r.environmentName, "Live");
  assertEquals(r.backups.map((b) => [b.id, b.type]), [[1, "autodaily"], [
    2,
    "manual",
  ]]);

  const run = (route: Route) =>
    listBackups(FAKE_KEY, ENV, {
      fetcher: fake(() => route).fetcher,
      wait: noWait,
    });
  await assertRejects(
    () =>
      run({
        status: 404,
        body: { message: "The requested environment was not found!" },
      }),
    Error,
    `Kinsta did not list the backups of environment ${ENV} (HTTP 404): The requested environment was not found!`,
  );
  for (
    const body of [{}, { environment: {} }, { environment: { backups: {} } }]
  ) {
    await assertRejects(() => run({ body }), Error, "no backup list");
  }
  await assertRejects(
    () => run({ body: backupsJson(Array(MAX_BACKUPS + 1).fill({ id: 1 })) }),
    Error,
    "no backup list",
  );
  await assertRejects(
    () => run({ body: backupsJson([{ id: "x" }]) }),
    Error,
    "backup without a usable id",
  );
  const none = fake(() => ({ body: backupsJson([]) }));
  for (const bad of ["", "x", `${ENV}/../x`, ENV.toUpperCase()]) {
    await assertRejects(
      () => listBackups(FAKE_KEY, bad, { fetcher: none.fetcher }),
      Error,
      "not a UUID",
    );
  }
  assertEquals(none.asked.length, 0);
});

Deno.test("recentWithTag finds the newest recent manual backup with the tag", () => {
  const list = [
    readBackup(backupJson(1, "before-update", "manual", NOW - 20 * 60_000)),
    readBackup(backupJson(2, "before-update", "manual", NOW - 10 * 60_000)),
    readBackup(backupJson(3, "before-update", "manual", NOW - 5 * 60_000)),
    readBackup(backupJson(4, "other", "manual", NOW - 60_000)),
    readBackup(backupJson(5, "before-update", "autodaily", NOW - 60_000)),
    readBackup({ id: 6, note: "before-update", type: "manual" }),
    readBackup(
      backupJson(7, "before-update", "manual", NOW + CLOCK_SKEW_MS + 1),
    ),
  ];
  const w = 15 * 60_000;
  assertEquals(recentWithTag(list, "before-update", w, NOW)?.id, 3);
  assertEquals(recentWithTag(list, "before-update", 4 * 60_000, NOW), null);
  assertEquals(recentWithTag(list, "nothing", w, NOW), null);
  assertEquals(recentWithTag([], "before-update", w, NOW), null);
  // exactly at the edge of the window still counts; one millisecond older does not
  const edge = [
    readBackup(backupJson(8, "t", "manual", NOW - w)),
    readBackup(backupJson(9, "t", "manual", NOW - w - 1)),
  ];
  assertEquals(recentWithTag(edge, "t", w, NOW)?.id, 8);
  assertEquals(recentWithTag([edge[1]], "t", w, NOW), null);
  // a small clock difference into the future is allowed
  const ahead = [
    readBackup(backupJson(10, "t", "manual", NOW + CLOCK_SKEW_MS)),
  ];
  assertEquals(recentWithTag(ahead, "t", w, NOW)?.id, 10);
  // same time: the higher id wins
  const tie = [
    readBackup(backupJson(11, "t", "manual", NOW - 1000)),
    readBackup(backupJson(12, "t", "manual", NOW - 1000)),
  ];
  assertEquals(recentWithTag(tie, "t", w, NOW)?.id, 12);
});

Deno.test("newBackup accepts only a manual backup with our tag, a new id and a time not before the request", () => {
  const before = new Set([1, 2]);
  const b = (id: number, note: string, type = "manual", at = NOW) =>
    readBackup(backupJson(id, note, type, at));
  const nb = (list: ReturnType<typeof readBackup>[]) =>
    newBackup(list, before, "t", NOW);
  assertEquals(nb([b(1, "t"), b(2, "t")]), null);
  assertEquals(nb([b(3, "other")]), null);
  assertEquals(nb([b(3, "t", "autodaily")]), null);
  assertEquals(nb([b(3, "t", "Manual")]), null);
  assertEquals(nb([b(3, "T")]), null);
  assertEquals(nb([b(1, "t"), b(3, "t")])?.id, 3);
  assertEquals(nb([b(3, "t"), b(4, "t")])?.id, 4);
  assertEquals(nb([]), null);
  // made before our request (someone else's, listed late): not ours. The clock allowance is five minutes.
  assertEquals(nb([b(3, "t", "manual", NOW - CLOCK_SKEW_MS - 1)]), null);
  assertEquals(nb([b(3, "t", "manual", NOW - CLOCK_SKEW_MS)])?.id, 3);
  assertEquals(nb([b(3, "t", "manual", NOW + 60_000)])?.id, 3);
  // Kinsta gave no usable time: the new id and the tag decide
  assertEquals(nb([readBackup({ id: 3, note: "t", type: "manual" })])?.id, 3);
});

// ---------------------------------------------------------------- createBackup

/** A fake Kinsta with a backup list that can change; counts the POSTs. */
function kinsta(start: unknown[], o: {
  post?: Route;
  appearAfterReads?: number;
  made?: unknown;
  listError?: (read: number) => Route | Error | null;
} = {}) {
  let list = [...start];
  let reads = 0;
  let posts = 0;
  const k = fake((req) => {
    if (req.method === "POST") {
      posts++;
      return o.post ??
        { status: 202, body: { operation_id: "backups:add-manual-abc123" } };
    }
    reads++;
    const err = o.listError?.(reads);
    if (err) return err;
    if (posts > 0 && reads > (o.appearAfterReads ?? 1)) {
      list = [
        ...start,
        o.made ?? backupJson(99, "before-update", "manual", NOW),
      ];
    }
    return { body: backupsJson(list) };
  });
  return { ...k, posts: () => posts, reads: () => reads };
}
const clock = (start = NOW, stepMs = 0) => {
  let t = start;
  return {
    now: () => t,
    wait: (ms: number) => {
      t += ms + stepMs;
      return Promise.resolve();
    },
  };
};

Deno.test("createBackup reads, asks once, then waits until Kinsta lists the new backup", async () => {
  const k = kinsta(
    [backupJson(1, "Daily", "autodaily"), backupJson(2, "old")],
    {
      appearAfterReads: 3,
    },
  );
  const c = clock();
  const logs: string[] = [];
  const made = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: k.fetcher,
    now: c.now,
    wait: c.wait,
    log: (n, s) => logs.push(`${n}: ${s}`),
  });
  assertEquals(made, {
    environmentId: ENV,
    id: 99,
    name: "backup-99",
    tag: "before-update",
    createdAt: new Date(NOW).toISOString(),
    reused: false,
    operationId: "backups:add-manual-abc123",
    manualCount: 2,
    attempts: 3,
  });
  assertEquals(k.posts(), 1);
  assertEquals(k.asked.map((r) => r.method), [
    "GET",
    "POST",
    "GET",
    "GET",
    "GET",
  ]);
  const post = k.asked[1];
  assertEquals(post.url, `${API}/sites/environments/${ENV}/manual-backups`);
  assertEquals(post.body, '{"tag":"before-update"}');
  assertEquals(logs, [
    "1: not listed yet",
    "2: not listed yet",
    "3: backup 99 is listed",
  ]);
  // only ever GET and POST, only ever under the API, never the key outside the header
  for (const r of k.asked) {
    assert(r.method === "GET" || r.method === "POST");
    assert(r.url.startsWith(`${API}/sites/environments/${ENV}/`));
    assert(!r.url.includes(FAKE_KEY) && !(r.body ?? "").includes(FAKE_KEY));
  }
});

Deno.test("createBackup finds a recent backup with the same tag again and asks for nothing", async () => {
  const k = kinsta([
    backupJson(5, "before-update", "manual", NOW - 10 * 60_000),
    backupJson(6, "other"),
  ]);
  const made = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: k.fetcher,
    now: () => NOW,
    wait: noWait,
  });
  assertEquals(made.reused, true);
  assertEquals(made.id, 5);
  assertEquals(made.operationId, null);
  assertEquals(made.attempts, 0);
  assertEquals(made.manualCount, 2);
  assertEquals(k.posts(), 0);
  assertEquals(k.asked.length, 1);

  // older than the window, or reuse switched off: a new one is requested
  for (
    const args of [{ ...ARGS, reuseWithinMinutes: 5 }, {
      ...ARGS,
      reuseWithinMinutes: 0,
    }]
  ) {
    const k2 = kinsta([
      backupJson(5, "before-update", "manual", NOW - 10 * 60_000),
    ]);
    const c = clock();
    const m = await createBackup(FAKE_KEY, ENV, args, {
      fetcher: k2.fetcher,
      now: c.now,
      wait: c.wait,
    });
    assertEquals(m.reused, false);
    assertEquals(m.id, 99);
    assertEquals(k2.posts(), 1);
  }
});

Deno.test("createBackup refuses at the manual limit and asks for nothing, unless told to proceed", async () => {
  const full = [1, 2, 3, 4, 5].map((i) => backupJson(i, `m${i}`));
  const k = kinsta([...full, backupJson(6, "Daily", "autodaily")]);
  await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, ARGS, {
        fetcher: k.fetcher,
        now: () => NOW,
        wait: noWait,
      }),
    Error,
    `environment ${ENV} already has 5 manual backups (limit 5); nothing requested`,
  );
  assertEquals(k.posts(), 0);

  // one under the limit is fine; automatic backups do not count
  const four = kinsta([
    ...full.slice(0, 4),
    backupJson(6, "Daily", "autodaily"),
  ]);
  const c = clock();
  await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: four.fetcher,
    now: c.now,
    wait: c.wait,
  });
  assertEquals(four.posts(), 1);

  // a lower limit refuses earlier
  const two = kinsta(full.slice(0, 2));
  await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, { ...ARGS, manualLimit: 2 }, {
        fetcher: two.fetcher,
        now: () => NOW,
        wait: noWait,
      }),
    Error,
    "(limit 2); nothing requested",
  );
  assertEquals(two.posts(), 0);

  const go = kinsta(full);
  const c2 = clock();
  const made = await createBackup(
    FAKE_KEY,
    ENV,
    { ...ARGS, whenFull: "proceed" },
    { fetcher: go.fetcher, now: c2.now, wait: c2.wait },
  );
  assertEquals(made.id, 99);
  assertEquals(go.posts(), 1);
});

Deno.test("createBackup stops when the first read fails: nothing is requested", async () => {
  const k = kinsta([], {
    listError: () => ({ status: 401, body: { error: "Invalid API key!" } }),
  });
  const e = await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, ARGS, {
        fetcher: k.fetcher,
        now: () => NOW,
        wait: noWait,
      }),
    Error,
    "HTTP 401",
  );
  assert(!e.message.includes(FAKE_KEY));
  assertEquals(k.posts(), 0);
  for (const bad of ["", "Bad Tag", "a--b", "a".repeat(41), "a\nb"]) {
    const k2 = kinsta([]);
    await assertRejects(
      () =>
        createBackup(FAKE_KEY, ENV, { ...ARGS, tag: bad }, {
          fetcher: k2.fetcher,
        }),
      Error,
      "not a usable backup tag",
    );
    assertEquals(k2.asked.length, 0);
  }
});

Deno.test("createBackup reports a refused request and never asks twice", async () => {
  for (
    const [post, want] of [
      [
        { status: 400, body: { message: "Environment is blocked" } },
        "Kinsta did not accept the backup request for environment " + ENV +
        " (HTTP 400): Environment is blocked",
      ],
      [{ status: 500, body: { message: "boom" } }, "(HTTP 500): boom"],
      [{ status: 404, body: { message: "not found" } }, "(HTTP 404)"],
      [{ status: 202, body: {} }, "gave no usable operation id"],
      [
        { status: 202, body: { operation_id: 7 } },
        "gave no usable operation id",
      ],
      [
        { status: 202, body: { operation_id: "bad id with spaces" } },
        "gave no usable operation id",
      ],
      [{ status: 202, body: "<html>" }, "not JSON"],
    ] as [Route, string][]
  ) {
    const k = kinsta([], { post });
    await assertRejects(
      () =>
        createBackup(FAKE_KEY, ENV, ARGS, {
          fetcher: k.fetcher,
          now: () => NOW,
          wait: noWait,
        }),
      Error,
      want,
    );
    assertEquals(k.posts(), 1, want);
    // the list was read once before the request and never polled after a refusal
    assertEquals(k.reads(), 1, want);
  }
});

Deno.test("createBackup gives up after waitMinutes with the operation id, having asked once", async () => {
  const k = kinsta([], { appearAfterReads: 1e9 });
  const c = clock();
  const e = await assertRejects(
    () =>
      createBackup(
        FAKE_KEY,
        ENV,
        { ...ARGS, waitMinutes: 1, pollSeconds: 20 },
        {
          fetcher: k.fetcher,
          now: c.now,
          wait: c.wait,
        },
      ),
    Error,
    "Kinsta accepted the backup request (operation backups:add-manual-abc123) but no new manual backup tagged before-update was listed within 1 min (not listed yet)",
  );
  assertStringIncludes(e.message, "check MyKinsta");
  assertEquals(k.posts(), 1);
  // 20 s, 40 s, 60 s: three reads after the request, then the deadline
  assertEquals(k.reads(), 1 + 3);
});

Deno.test("createBackup rides out a list that cannot be read while it waits", async () => {
  const k = kinsta([], {
    // read 2 is refused outright; reads 3 to 5 are one poll whose every retry fails on the network
    appearAfterReads: 5,
    listError: (read) =>
      read === 2
        ? { status: 400, body: { message: `oops ${FAKE_KEY}` } }
        : read >= 3 && read <= 5
        ? new Error(`network down ${FAKE_KEY}`)
        : null,
  });
  const c = clock();
  const logs: string[] = [];
  const made = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: k.fetcher,
    now: c.now,
    wait: c.wait,
    log: (n, s) => logs.push(`${n}: ${s}`),
  });
  assertEquals(made.id, 99);
  assertEquals(made.attempts, 3);
  assertEquals(k.posts(), 1);
  assertStringIncludes(logs[0], "1: the list could not be read (Kinsta did");
  assertStringIncludes(logs[0], "(HTTP 400): oops [api key]");
  assertStringIncludes(logs[1], "2: the list could not be read (Kinsta could");
  assertEquals(logs[2], "3: backup 99 is listed");
  assert(!logs.join("\n").includes(FAKE_KEY));

  // and when it never comes back, the last reason is in the error
  const dead = kinsta([], {
    listError: (read) =>
      read > 1 ? { status: 503, body: { message: "maintenance" } } : null,
  });
  const c2 = clock();
  await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, { ...ARGS, waitMinutes: 1 }, {
        fetcher: dead.fetcher,
        now: c2.now,
        wait: c2.wait,
      }),
    Error,
    "the list could not be read (Kinsta did not list the backups",
  );
  assertEquals(dead.posts(), 1);
});

Deno.test("createBackup stops waiting when the run is cancelled", async () => {
  const stop = new AbortController();
  const k = kinsta([], { appearAfterReads: 1e9 });
  let waits = 0;
  await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, ARGS, {
        fetcher: k.fetcher,
        now: () => NOW,
        cancel: stop.signal,
        wait: () => {
          if (++waits === 2) {
            stop.abort(new Error("cancelled"));
            return Promise.reject(stop.signal.reason);
          }
          return Promise.resolve();
        },
      }),
    Error,
    "cancelled",
  );
  assertEquals(k.posts(), 1);
  assertEquals(k.reads(), 2);
});

Deno.test("createBackup does not take another backup for its own", async () => {
  // someone else's manual backup with another tag, and an automatic one, appear after the request
  for (
    const made of [
      backupJson(99, "someone-else", "manual", NOW),
      backupJson(99, "before-update", "autodaily", NOW),
    ]
  ) {
    const k = kinsta([], { made });
    const c = clock();
    await assertRejects(
      () =>
        createBackup(FAKE_KEY, ENV, { ...ARGS, waitMinutes: 1 }, {
          fetcher: k.fetcher,
          now: c.now,
          wait: c.wait,
        }),
      Error,
      "no new manual backup tagged before-update",
    );
  }
});

// ---------------------------------------------------------------- the model

Deno.test("the model declares its type, version, methods and a sensitive key", () => {
  assertEquals(model.type, "@jayr/kinsta");
  assertEquals(model.version, "2026.11.20.2");
  // the one upgrade so far changes nothing
  assertEquals(model.upgrades.map((u) => u.toVersion), ["2026.11.20.2"]);
  const kept = { apiKey: "x", companyId: "y" };
  assertEquals(model.upgrades[0].upgradeAttributes(kept), kept);
  assertEquals(Object.keys(model.methods), [
    "sites",
    "backups",
    "create_backup",
  ]);
  assertEquals(model.methods.sites.kind, "list");
  assertEquals(model.methods.backups.kind, "list");
  assert(!("kind" in model.methods.create_backup));
  assertEquals(Object.keys(model.resources), ["sites", "backups", "backup"]);
  const shape = model.globalArguments.shape;
  assertEquals(shape.apiKey.meta()?.sensitive, true);
  assertEquals(shape.companyId.meta()?.sensitive, undefined);
});

Deno.test("global arguments refuse a bad key without repeating it, and a bad company id", () => {
  const ok = { apiKey: FAKE_KEY, companyId: COMPANY };
  assert(model.globalArguments.safeParse(ok).success);
  for (
    const apiKey of [
      "short",
      `${FAKE_KEY} with space`,
      `${FAKE_KEY}\nx: y`,
      "${{vault.get(kinsta,api-key)}}",
      "${{ vault.get(kinsta, api-key) }}",
    ]
  ) {
    const r = model.globalArguments.safeParse({ ...ok, apiKey });
    assert(!r.success, apiKey);
    assert(!JSON.stringify(r.error.issues).includes(apiKey), apiKey);
    assert(!r.error.message.includes(apiKey), apiKey);
  }
  for (const companyId of ["", "x", COMPANY.toUpperCase(), `${COMPANY}&x=1`]) {
    assert(!model.globalArguments.safeParse({ ...ok, companyId }).success);
  }
  assert(!model.globalArguments.safeParse({ companyId: COMPANY }).success);
});

Deno.test("method arguments have safe defaults and limits", () => {
  const c = model.methods.create_backup.arguments;
  assertEquals(c.parse({ environmentId: ENV, tag: "t" }), {
    environmentId: ENV,
    tag: "t",
    waitMinutes: 15,
    pollSeconds: 15,
    manualLimit: 5,
    whenFull: "refuse",
    reuseWithinMinutes: 60,
  });
  for (
    const bad of [
      { tag: "t" },
      { environmentId: "x", tag: "t" },
      { environmentId: ENV },
      { environmentId: ENV, tag: "Bad" },
      { environmentId: ENV, tag: "a".repeat(41) },
      { environmentId: ENV, tag: "t", waitMinutes: 0 },
      { environmentId: ENV, tag: "t", waitMinutes: 61 },
      { environmentId: ENV, tag: "t", pollSeconds: 4 },
      { environmentId: ENV, tag: "t", pollSeconds: 301 },
      { environmentId: ENV, tag: "t", manualLimit: 0 },
      { environmentId: ENV, tag: "t", manualLimit: 2.5 },
      { environmentId: ENV, tag: "t", whenFull: "delete" },
      { environmentId: ENV, tag: "t", reuseWithinMinutes: -1 },
      { environmentId: ENV, tag: "t", reuseWithinMinutes: 1441 },
    ]
  ) {
    assert(!c.safeParse(bad).success, JSON.stringify(bad));
  }
  assert(
    !model.methods.backups.arguments.safeParse({ environmentId: "x" }).success,
  );
  assert(
    model.methods.backups.arguments.safeParse({ environmentId: ENV })
      .success,
  );
});

/** Runs one method against a stubbed global fetch and returns everything it logged, wrote or threw. */
async function run(
  method: keyof typeof model.methods,
  args: Record<string, unknown>,
  answer: (req: Req, n: number) => Route | Error,
  signal?: AbortSignal,
) {
  const real = globalThis.fetch;
  const asked: Req[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  globalThis.fetch = ((url: URL, init: RequestInit) => {
    signals.push(init.signal);
    if (init.signal?.aborted) return Promise.reject(init.signal.reason);
    const req = {
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    };
    const r = answer(req, asked.length);
    asked.push(req);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(
      new Response(
        typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}),
        { status: r.status ?? 200, headers: r.headers },
      ),
    );
  }) as typeof fetch;
  const logs: string[] = [];
  const written: { spec: string; name: string; data: unknown }[] = [];
  let error: Error | null = null;
  let result: unknown = null;
  try {
    // deno-lint-ignore no-explicit-any
    result = await (model.methods[method].execute as any)(args, {
      globalArgs: { apiKey: FAKE_KEY, companyId: COMPANY },
      logger: {
        info: (msg: string, props?: Record<string, unknown>) =>
          logs.push(`${msg} ${JSON.stringify(props ?? {})}`),
      },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      signal,
    });
  } catch (e) {
    error = e as Error;
  } finally {
    globalThis.fetch = real;
  }
  // the one rule that holds for every run: the key is in the Authorization header and nowhere else
  const everything = JSON.stringify({
    logs,
    written,
    result,
    error: error ? `${error.message}\n${error.stack}` : null,
    urls: asked.map((r) => r.url),
    bodies: asked.map((r) => r.body),
  });
  assert(!everything.includes(FAKE_KEY), "the key leaked");
  for (const r of asked) {
    assertEquals(r.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert(r.url.startsWith(`${API}/`), r.url);
    assert(r.method === "GET" || r.method === "POST", r.method);
  }
  return { asked, logs, written, error, result, signals };
}

Deno.test("sites writes one resource with the reduced list", async () => {
  const r = await run("sites", {}, () => ({ body: sitesJson() }));
  assertEquals(r.error, null);
  assertEquals(r.asked.length, 1);
  assertEquals(r.written.length, 1);
  assertEquals(r.written[0].spec, "sites");
  assertEquals(r.written[0].name, "sites");
  const d = r.written[0].data as Record<string, unknown>;
  assertEquals(d.companyId, COMPANY);
  assertEquals(d.siteCount, 1);
  assertEquals(d.environmentCount, 2);
  assert(model.resources.sites.schema.safeParse(d).success);
  assert(!JSON.stringify(d).includes("192.0.2.10"));
  assert(!JSON.stringify(d).includes("/www/"));
  assertEquals(r.result, { dataHandles: [{ name: "sites" }] });
  assertEquals(r.logs.length, 2);
});

Deno.test("sites writes nothing when Kinsta refuses, and the error carries no key", async () => {
  const r = await run(
    "sites",
    {},
    () => ({ status: 401, body: { error: `Invalid API key! ${FAKE_KEY}` } }),
  );
  assertEquals(r.written, []);
  assertStringIncludes(r.error!.message, "HTTP 401");
  const net = await run(
    "sites",
    {},
    () => new Error(`tls failure talking with Bearer ${FAKE_KEY}`),
  );
  assertEquals(net.written, []);
  assertStringIncludes(net.error!.message, "Kinsta could not be reached");
});

Deno.test("backups writes one resource named after the environment, without internal fields", async () => {
  const r = await run("backups", { environmentId: ENV }, () => ({
    body: backupsJson([
      backupJson(1, "Daily", "autodaily"),
      backupJson(2, "before-update"),
    ]),
  }));
  assertEquals(r.error, null);
  assertEquals(r.written[0].spec, "backups");
  assertEquals(r.written[0].name, `backups-${ENV}`);
  const d = r.written[0].data as {
    backups: Record<string, unknown>[];
    manualCount: number;
    backupCount: number;
  };
  assertEquals(d.backupCount, 2);
  assertEquals(d.manualCount, 1);
  assert(!("createdAtMs" in d.backups[0]));
  assert(model.resources.backups.schema.safeParse(d).success);
  const bad = await run(
    "backups",
    { environmentId: ENV },
    () => ({ status: 404, body: { message: "nope" } }),
  );
  assertEquals(bad.written, []);
  assertStringIncludes(bad.error!.message, "HTTP 404");
});

Deno.test("create_backup writes the backup it found again and asks for nothing", async () => {
  const r = await run(
    "create_backup",
    { ...ARGS },
    () => ({
      body: backupsJson([
        backupJson(5, "before-update", "manual", Date.now() - 60_000),
      ]),
    }),
  );
  assertEquals(r.error, null);
  assertEquals(r.asked.map((q) => q.method), ["GET"]);
  assertEquals(r.written[0].spec, "backup");
  assertEquals(r.written[0].name, `backup-${ENV}`);
  const d = r.written[0].data as Record<string, unknown>;
  assertEquals(d.reused, true);
  assertEquals(d.id, 5);
  assert(model.resources.backup.schema.safeParse(d).success);
});

Deno.test("create_backup writes nothing when the request is refused or the limit is reached", async () => {
  const full = [1, 2, 3, 4, 5].map((i) => backupJson(i, `m${i}`));
  const atLimit = await run(
    "create_backup",
    { ...ARGS },
    () => ({ body: backupsJson(full) }),
  );
  assertEquals(atLimit.written, []);
  assertEquals(atLimit.asked.map((q) => q.method), ["GET"]);
  assertStringIncludes(atLimit.error!.message, "nothing requested");

  const refused = await run(
    "create_backup",
    { ...ARGS },
    (req) =>
      req.method === "POST"
        ? { status: 400, body: { message: `blocked ${FAKE_KEY}` } }
        : { body: backupsJson([]) },
  );
  assertEquals(refused.written, []);
  assertEquals(refused.asked.map((q) => q.method), ["GET", "POST"]);
  assertStringIncludes(refused.error!.message, "HTTP 400");
});

// ---------------------------------------------------------------- added after the first review round

Deno.test("scrub removes pieces of the key and other letter cases", () => {
  assertEquals(
    scrub(`x ${FAKE_KEY.toUpperCase()} y`, FAKE_KEY),
    "x [api key] y",
  );
  assertEquals(
    scrub(`x ${FAKE_KEY.slice(0, 12)} y`, FAKE_KEY),
    "x [api key] y",
  );
  assertEquals(scrub(`x ${FAKE_KEY.slice(-8)} y`, FAKE_KEY), "x [api key] y");
  assertEquals(
    scrub(`x ${FAKE_KEY.slice(5, 13)} y`, FAKE_KEY),
    "x [api key] y",
  );
  // seven characters of it are not treated as the key
  const seven = FAKE_KEY.slice(0, 7);
  assertEquals(scrub(`x ${seven} y`, FAKE_KEY), `x ${seven} y`);
  // two copies with nothing between them
  assertEquals(scrub(`${FAKE_KEY}${FAKE_KEY}`, FAKE_KEY), "[api key]");
  assertEquals(scrub(FAKE_KEY, FAKE_KEY), "[api key]");
  // characters that mean something in a pattern or a replacement are plain text here
  const odd = "$&$1.*+?^(){}[]|\\/abc";
  assertEquals(scrub(`a ${odd} b`, odd), "a [api key] b");
  // a key shorter than a piece is still removed whole
  assertEquals(scrub("a secret b", "secret"), "a [api key] b");
  // text around it keeps its own letter case and position
  assertEquals(scrub(`ÄB ${FAKE_KEY} Çd`, FAKE_KEY), "ÄB [api key] Çd");
});

Deno.test("safeText finds a key that invisible characters or a line break try to hide", () => {
  const a = FAKE_KEY.slice(0, 20);
  const b = FAKE_KEY.slice(20);
  for (const hidden of ["​", "⁠", "­", "﻿", "‮"]) {
    assertEquals(safeText(`x ${a}${hidden}${b} y`, FAKE_KEY), "x [api key] y");
  }
  // a line break splits it in two pieces; both are removed
  assertEquals(
    safeText(`x ${a}\n${b} y`, FAKE_KEY),
    "x [api key] [api key] y",
  );
  // escaped the way JSON would write it
  assertEquals(
    safeText(JSON.stringify({ key: FAKE_KEY }), FAKE_KEY),
    '{"key":"[api key]"}',
  );
  for (const v of [null, undefined, 7, {}, ["x"]]) {
    assertEquals(safeText(v, FAKE_KEY), null);
  }
  assertEquals(safeText("   ", FAKE_KEY), null);
  // a key far beyond what is ever shown is cut away, never shown in part
  const far = safeText("y".repeat(5000) + FAKE_KEY, FAKE_KEY)!;
  assertEquals(far, "y".repeat(200));
});

Deno.test("clean breaks up a swamp expression, drops unassigned characters and never walks a huge value", () => {
  assertEquals(
    clean("${{ vault.get(default, kinsta-api-key) }}"),
    "$ {{ vault.get(default, kinsta-api-key) }}",
  );
  assertEquals(clean("a${{b}}${{c}}"), "a$ {{b}}$ {{c}}");
  assertEquals(clean("$​{{ x }}"), "$ {{ x }}");
  assertEquals(clean("a￿b⠀c"), "a b c");
  const t0 = performance.now();
  assertEquals(clean("z".repeat(8_000_000))!.length, 200);
  assert(performance.now() - t0 < 100, "a huge value took too long");
});

Deno.test("requestSignal always carries the timeout, also next to a cancel signal", async () => {
  const never = new AbortController();
  for (
    const make of [
      () => requestSignal(never.signal, 20),
      () => requestSignal(undefined, 20),
    ]
  ) {
    const s = make();
    assert(!s.aborted);
    await new Promise((r) => setTimeout(r, 60));
    assert(s.aborted, "the timeout did not fire");
    assertEquals((s.reason as Error).name, "TimeoutError");
  }
  const stop = new AbortController();
  const joined = requestSignal(stop.signal, 60_000);
  stop.abort(new Error("cancelled"));
  assert(joined.aborted);
  assertEquals((joined.reason as Error).message, "cancelled");

  // kinstaFetch hands fetch that joined signal, never the bare cancel signal
  const real = globalThis.fetch;
  let got: AbortSignal | null | undefined;
  globalThis.fetch = ((_u: URL, init: RequestInit) => {
    got = init.signal;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  try {
    await kinstaFetch(`${API}/sites`, GET, never.signal);
    assert(got instanceof AbortSignal);
    assert(got !== never.signal);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("only a plain 200 is a list: any other success status is refused", async () => {
  for (const status of [201, 202, 206, 299]) {
    await assertRejects(
      () =>
        listSites(FAKE_KEY, COMPANY, {
          fetcher: fake(() => ({ status, body: sitesJson() })).fetcher,
        }),
      Error,
      `(HTTP ${status})`,
    );
    await assertRejects(
      () =>
        listBackups(FAKE_KEY, ENV, {
          fetcher: fake(() => ({ status, body: backupsJson([]) })).fetcher,
        }),
      Error,
      `(HTTP ${status})`,
    );
  }
});

Deno.test("the readers clean every text Kinsta sends", () => {
  const dirty = "a\nb‮c${{ x }}";
  const tidy = "a b c$ {{ x }}";
  const b = readBackup({ id: 1, name: dirty, note: dirty, type: dirty });
  assertEquals([b.name, b.note, b.type], [tidy, tidy, tidy]);
  const e = readEnvironment({
    id: ENV,
    name: dirty,
    display_name: dirty,
    wordpress_version: "<b>6.8</b>",
    container_info: { php_engine_version: "php 8.3; rm -rf" },
    primaryDomain: { name: "bad host name" },
  });
  assertEquals([e.name, e.displayName], [tidy, tidy]);
  assertEquals(e.wordpressVersion, null);
  assertEquals(e.phpVersion, "php");
  assertEquals(e.primaryDomain, null);
  const s = readSite({
    id: SITE,
    name: dirty,
    display_name: dirty,
    status: dirty,
    site_labels: [{ name: dirty }],
  });
  assertEquals([s.name, s.displayName, s.status, s.labels[0]], [
    tidy,
    tidy,
    tidy,
    tidy,
  ]);
});

Deno.test("createBackup does not mistake an older backup with the same tag for the new one", async () => {
  // an old backup with our tag, outside the reuse window, is in the list from the start
  const old = backupJson(7, "before-update", "manual", NOW - 2 * 3600_000);
  const k = kinsta([old], { appearAfterReads: 2 });
  const c = clock();
  const made = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: k.fetcher,
    now: c.now,
    wait: c.wait,
  });
  assertEquals(made.id, 99);
  assertEquals(made.attempts, 2);
  assertEquals(made.reused, false);
  assertEquals(k.posts(), 1);

  // a backup with our tag made well before our request, but listed only after it, is someone else's
  const late = kinsta([], {
    made: backupJson(99, "before-update", "manual", NOW - CLOCK_SKEW_MS - 1),
  });
  const c2 = clock();
  await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, { ...ARGS, waitMinutes: 1 }, {
        fetcher: late.fetcher,
        now: c2.now,
        wait: c2.wait,
      }),
    Error,
    "no new manual backup tagged before-update",
  );
});

Deno.test("createBackup counts and reuses only backups whose type is exactly manual", async () => {
  const odd = [
    { id: 1, note: "a", type: "Manual", created_at: NOW - 1000 },
    { id: 2, note: "b", type: null, created_at: NOW - 1000 },
    { id: 3, note: "c", created_at: NOW - 1000 },
    { id: 4, note: "d", type: "autodaily", created_at: NOW - 1000 },
    { id: 5, note: "before-update", type: "MANUAL", created_at: NOW - 1000 },
    { id: 6, note: "before-update", type: "system", created_at: NOW - 1000 },
  ];
  const k = kinsta(odd);
  const c = clock();
  const made = await createBackup(FAKE_KEY, ENV, { ...ARGS, manualLimit: 1 }, {
    fetcher: k.fetcher,
    now: c.now,
    wait: c.wait,
  });
  assertEquals(made.reused, false);
  assertEquals(made.id, 99);
  assertEquals(made.manualCount, 1);
  assertEquals(k.posts(), 1);
});

Deno.test("createBackup with reuse switched off asks even when a backup with the tag was made this second", async () => {
  for (const at of [NOW, NOW + 1000, NOW - 1]) {
    const k = kinsta([backupJson(5, "before-update", "manual", at)], {
      made: backupJson(99, "before-update", "manual", NOW + 2000),
    });
    const c = clock();
    const made = await createBackup(
      FAKE_KEY,
      ENV,
      { ...ARGS, reuseWithinMinutes: 0 },
      { fetcher: k.fetcher, now: c.now, wait: c.wait },
    );
    assertEquals(made.id, 99);
    assertEquals(made.reused, false);
    assertEquals(k.posts(), 1);
  }
});

Deno.test("createBackup takes any 2xx with an operation id as accepted", async () => {
  for (const status of [200, 201, 202]) {
    const k = kinsta([], { post: { status, body: { operation_id: "op-1" } } });
    const c = clock();
    const made = await createBackup(FAKE_KEY, ENV, ARGS, {
      fetcher: k.fetcher,
      now: c.now,
      wait: c.wait,
    });
    assertEquals(made.operationId, "op-1");
    assertEquals(k.posts(), 1);
  }
});

Deno.test("createBackup says when the request may have reached Kinsta, and only then", async () => {
  const attempt = async (post: Route | Error) => {
    let posts = 0;
    let reads = 0;
    const k = fake((req) => {
      if (req.method === "POST") {
        posts++;
        return post;
      }
      reads++;
      return { body: backupsJson([]) };
    });
    const e = await assertRejects(() =>
      createBackup(FAKE_KEY, ENV, ARGS, {
        fetcher: k.fetcher,
        now: () => NOW,
        wait: noWait,
      })
    ) as Error;
    // asked once, and the list is not polled after a request that did not end cleanly
    assertEquals(posts, 1);
    assertEquals(reads, 1);
    assert(!e.message.includes(FAKE_KEY.slice(0, 8)), e.message);
    return e.message;
  };
  // a clear "no": nothing to check
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const m = await attempt({ status, body: { message: "no" } });
    assertStringIncludes(m, `(HTTP ${status}): no`);
    assert(!m.includes(MAYBE_STARTED), m);
  }
  // everything else leaves it open, and the message says so
  for (
    const post of [
      new Error(`connection reset ${FAKE_KEY}`),
      { status: 500, body: { message: "boom" } },
      { status: 502, body: "<html>bad gateway</html>" },
      { status: 504, body: { message: "timeout" } },
      { status: 202, body: "" },
      { status: 202, body: {} },
      { status: 202, body: { operation_id: "bad id" } },
      { status: 100, body: {} },
    ] as (Route | Error)[]
  ) {
    const m = await attempt(post);
    assertStringIncludes(m, MAYBE_STARTED);
  }
  assertStringIncludes(MAYBE_STARTED, "before asking again");
});

Deno.test("createBackup stops after a fixed number of reads even when the clock does not move", async () => {
  const k = kinsta([], { appearAfterReads: 1e9 });
  let waits = 0;
  await assertRejects(
    () =>
      createBackup(
        FAKE_KEY,
        ENV,
        { ...ARGS, waitMinutes: 1, pollSeconds: 20 },
        {
          fetcher: k.fetcher,
          now: () => NOW,
          wait: () => {
            waits++;
            return Promise.resolve();
          },
        },
      ),
    Error,
    "was listed within 1 min",
  );
  // 60 s / 20 s = 3 reads, plus one
  assertEquals(waits, 4);
  assertEquals(k.reads(), 1 + 4);
  assertEquals(k.posts(), 1);
});

Deno.test("createBackup keeps the key out of the time-out error and the cancel error", async () => {
  const k = kinsta([], {
    listError: (read) =>
      read > 1
        ? { status: 403, body: { message: `denied for ${FAKE_KEY}` } }
        : null,
  });
  const c = clock();
  const e = await assertRejects(() =>
    createBackup(FAKE_KEY, ENV, { ...ARGS, waitMinutes: 1 }, {
      fetcher: k.fetcher,
      now: c.now,
      wait: c.wait,
    })
  ) as Error;
  assertStringIncludes(e.message, "denied for [api key]");
  assert(!e.message.includes(FAKE_KEY.slice(0, 8)));

  const stop = new AbortController();
  let reads = 0;
  const raw = fake((req) => {
    if (req.method === "POST") {
      return { status: 202, body: { operation_id: "op-1" } };
    }
    if (++reads === 1) return { body: backupsJson([]) };
    stop.abort(new Error("cancelled"));
    return new Error(`raw failure with ${FAKE_KEY}`);
  });
  const x = await assertRejects(() =>
    createBackup(FAKE_KEY, ENV, ARGS, {
      fetcher: raw.fetcher,
      now: () => NOW,
      wait: noWait,
      cancel: stop.signal,
    })
  ) as Error;
  assertStringIncludes(x.message, "cancelled");
  assert(!x.message.includes(FAKE_KEY.slice(0, 8)), x.message);
});

Deno.test("every method hands swamp's cancel signal to its requests", async () => {
  const stop = new AbortController();
  stop.abort(new Error("cancelled by the operator"));
  for (
    const [method, args] of [
      ["sites", {}],
      ["backups", { environmentId: ENV }],
      ["create_backup", { ...ARGS }],
    ] as [keyof typeof model.methods, Record<string, unknown>][]
  ) {
    const r = await run(
      method,
      args,
      () => ({ body: sitesJson() }),
      stop.signal,
    );
    assertEquals(r.written, [], method);
    assertEquals(r.asked.length, 0, method);
    assertEquals(r.signals.length, 1, method);
    assert(r.signals[0]?.aborted, method);
    assertStringIncludes(r.error!.message, "cancelled", method);
  }
});

// ---------------------------------------------------------------- added after the second review round

Deno.test("safeText withholds a text in which separators hide the key", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const every7 = (sep: string) => key.match(/.{1,7}/g)!.join(sep);
  for (const sep of ["\n", " ", " ", "⠀", " ", "\t", "\r\n", "\u0000"]) {
    const out = safeText(`error: ${every7(sep)} end`, key)!;
    assertEquals(out, "[text withheld: it held a piece of the api key]", sep);
    assert(!out.includes("0123456"), sep);
  }
  // an ordinary text with spaces is left alone
  assertEquals(
    safeText("The requested company was not found!", key),
    "The requested company was not found!",
  );
  assert(holdsKey(`x${key.slice(3, 11)}y`, key));
  assert(!holdsKey(`x${key.slice(3, 10)}y`, "zzzzzzzzzzzzzzzzzzzz"));
  assert(!holdsKey("", key));
});

Deno.test("scrub keeps every position right when lower case would change the length of the text", () => {
  // "İ" becomes two characters in lower case; the key after it must still be removed whole and nothing else
  assertEquals(scrub(`İİİ ${FAKE_KEY} end`, FAKE_KEY), "İİİ [api key] end");
  assertEquals(
    scrub(`İİİ ${FAKE_KEY.toUpperCase()} end`, FAKE_KEY),
    "İİİ [api key] end",
  );
});

Deno.test("reason never throws, whatever was thrown", () => {
  assertEquals(reason(Object.create(null), FAKE_KEY), "unknown error");
  assertEquals(reason(undefined, FAKE_KEY), "undefined");
  assertEquals(reason(Symbol("s"), FAKE_KEY), "Symbol(s)");
  assertEquals(
    reason({ toString: () => `has ${FAKE_KEY}` }, FAKE_KEY),
    "has [api key]",
  );
});

Deno.test("clean and safeText handle each class of invisible character on its own", () => {
  // one character from each class, none of them in two classes at once
  const each: [string, string][] = [
    ["؀", "format"],
    ["͏", "default ignorable"],
    ["ㅤ", "default ignorable (filler)"],
    ["", "private use"],
    ["\uD800", "lone surrogate"],
    ["\u0007", "control"],
    ["￿", "unassigned"],
  ];
  for (const [ch, what] of each) {
    assertEquals(clean(`a${ch}b`), "a b", what);
  }
  const a = FAKE_KEY.slice(0, 20);
  const b = FAKE_KEY.slice(20);
  for (const ch of ["؀", "͏", "ㅤ"]) {
    assertEquals(safeText(`x ${a}${ch}${b} y`, FAKE_KEY), "x [api key] y");
  }
});

Deno.test("kinstaFetch refuses look-alike hosts, each kind of credential and paths outside /v2/", async () => {
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (() => {
    called++;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  try {
    for (
      const url of [
        "https://evil-api.kinsta.com/v2/sites",
        "https://x.api.kinsta.com/v2/sites",
        "https://api.kinsta.com.example/v2/sites",
        "https://user@api.kinsta.com/v2/sites",
        "https://:pw@api.kinsta.com/v2/sites",
        "https://api.kinsta.com/v2",
        "https://api.kinsta.com/v2x/sites",
        "https://api.kinsta.com/v2/../v1/sites",
      ]
    ) {
      await assertRejects(
        () => kinstaFetch(url, GET),
        Error,
        "outside the Kinsta API",
        url,
      );
    }
    assertEquals(called, 0);
    // the two ends of the redirect range, and the statuses just outside it
    for (
      const [status, refused] of [[300, true], [399, true], [299, false], [
        400,
        false,
      ]] as const
    ) {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(status === 299 ? "{}" : null, { status }),
        )) as typeof fetch;
      if (refused) {
        await assertRejects(
          () => kinstaFetch(`${API}/sites`, GET),
          Error,
          "redirect",
        );
      } else {
        assertEquals((await kinstaFetch(`${API}/sites`, GET)).status, status);
      }
    }
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("KEY refuses the delete character and accepts the two ends of its length", () => {
  assert(!KEY.test("a".repeat(15) + "\x7f"));
  assert(KEY.test("a".repeat(16)));
  assert(KEY.test("~".repeat(512)));
  assert(KEY.test("!".repeat(16)));
});

Deno.test("readBody refuses one oversized chunk without keeping it, and stops the download", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(4));
      c.enqueue(new Uint8Array(50));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assertRejects(() => readBody(new Response(stream), 10), BodyTooLarge);
  assert(cancelled, "the download was not stopped");
  // exactly the cap is fine
  assertEquals((await readBody(new Response("x".repeat(10)), 10)).length, 10);
});

Deno.test("call stops the download of an answer it will not read", async () => {
  for (const status of [429, 503]) {
    let cancelled = 0;
    let n = 0;
    const fetcher = () => {
      if (++n > 1) return Promise.resolve(new Response("{}"));
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      });
      return Promise.resolve(new Response(body, { status }));
    };
    await call(FAKE_KEY, "GET", "/x", { fetcher, wait: noWait });
    assertEquals(cancelled, 1, String(status));
  }
});

Deno.test("call tries a read again when the answer stops half-way, and a write never", async () => {
  const half = '{"environment":{"backups":[';
  const k = fake((_r, n) => n === 0 ? { body: half } : { body: { ok: 1 } });
  assertEquals(
    (await call(FAKE_KEY, "GET", "/x", { fetcher: k.fetcher, wait: noWait }))
      .body,
    { ok: 1 },
  );
  assertEquals(k.asked.length, 2);
  const always = fake(() => ({ body: half }));
  await assertRejects(
    () =>
      call(FAKE_KEY, "GET", "/x", { fetcher: always.fetcher, wait: noWait }),
    Error,
    "a body that is not JSON",
  );
  assertEquals(always.asked.length, 3);
  const post = fake(() => ({ status: 202, body: half }));
  await assertRejects(
    () =>
      call(FAKE_KEY, "POST", "/x", { fetcher: post.fetcher, wait: noWait }, {
        tag: "t",
      }),
    Error,
    "a body that is not JSON",
  );
  assertEquals(post.asked.length, 1);
});

Deno.test("a run cancelled while it waits throws a scrubbed error, never the raw reason", async () => {
  const cut = () => Promise.reject(new Error(`stopped ${FAKE_KEY}`));
  // waiting out a 429, backing off after a 5xx, and the wait between two polls
  for (const status of [429, 503]) {
    const k = fake(() => ({ status, body: {} }));
    const e = await assertRejects(() =>
      call(FAKE_KEY, "GET", "/x", { fetcher: k.fetcher, wait: cut })
    ) as Error;
    assertEquals(e.message, "cancelled: stopped [api key]");
  }
  const k = kinsta([]);
  const e = await assertRejects(() =>
    createBackup(FAKE_KEY, ENV, ARGS, {
      fetcher: k.fetcher,
      now: () => NOW,
      wait: cut,
    })
  ) as Error;
  assert(
    e.message.startsWith("cancelled: stopped [api key]. Kinsta had accepted"),
    e.message,
  );
  assertEquals(k.posts(), 1);
  // a plain abort without a message still reads as a cancel
  const stop = new AbortController();
  stop.abort();
  const plain = await assertRejects(() =>
    call(FAKE_KEY, "GET", "/x", {
      fetcher: fake(() => ({ status: 429, body: {} })).fetcher,
      cancel: stop.signal,
    })
  ) as Error;
  assertStringIncludes(plain.message, "cancelled: ");
});

Deno.test("exactly at a cap is read, one more is refused", () => {
  const envs = (n: number) => Array.from({ length: n }, () => envJson());
  assertEquals(
    readSite({ id: SITE, environments: envs(MAX_ENVIRONMENTS) }).environments
      .length,
    MAX_ENVIRONMENTS,
  );
  assertThrows(() =>
    readSite({ id: SITE, environments: envs(MAX_ENVIRONMENTS + 1) })
  );
  const labels = (n: number) =>
    Array.from({ length: n }, () => ({ name: "a" }));
  assertEquals(
    readSite({ id: SITE, site_labels: labels(MAX_LABELS) }).labels.length,
    MAX_LABELS,
  );
  assertThrows(() =>
    readSite({ id: SITE, site_labels: labels(MAX_LABELS + 1) })
  );
});

Deno.test("the lists are read exactly at their caps", async () => {
  const sites = Array.from({ length: MAX_SITES }, () => ({ id: SITE }));
  assertEquals(
    (await listSites(FAKE_KEY, COMPANY, {
      fetcher: fake(() => ({ body: sitesJson(sites) })).fetcher,
    })).length,
    MAX_SITES,
  );
  const backups = Array.from(
    { length: MAX_BACKUPS },
    (_v, i) => ({ id: i + 1 }),
  );
  assertEquals(
    (await listBackups(FAKE_KEY, ENV, {
      fetcher: fake(() => ({ body: backupsJson(backups) })).fetcher,
    })).backups.length,
    MAX_BACKUPS,
  );
});

Deno.test("readSite and listBackups keep only their own fields", async () => {
  const s = readSite({
    ...siteJson({ environments: [] }),
    company_id: COMPANY,
    secret_note: "x",
    ssh: "y",
  });
  assertEquals(s, {
    id: SITE,
    name: "examplesite",
    displayName: "Example Site",
    status: "live",
    labels: ["shop"],
    environments: [],
  });
  const r = await listBackups(FAKE_KEY, ENV, {
    fetcher: fake(() => ({
      body: {
        environment: {
          display_name: "Li\nve‮",
          backups: [{ id: 1, extra: "x" }],
        },
      },
    })).fetcher,
  });
  assertEquals(r.environmentName, "Li ve");
  assertEquals(Object.keys(r.backups[0]).sort(), [
    "createdAt",
    "createdAtMs",
    "id",
    "name",
    "note",
    "type",
  ]);
});

Deno.test("createBackup tells its own backup from an older one by the id alone when it has to", async () => {
  // reuse is off, and an older backup with the same tag was made two minutes ago: inside the clock allowance,
  // so only "this id was already there" can tell them apart
  const old = backupJson(7, "before-update", "manual", NOW - 120_000);
  const k = kinsta([old], { appearAfterReads: 2 });
  const c = clock();
  const made = await createBackup(FAKE_KEY, ENV, {
    ...ARGS,
    reuseWithinMinutes: 0,
  }, {
    fetcher: k.fetcher,
    now: c.now,
    wait: c.wait,
  });
  assertEquals(made.id, 99);
  assertEquals(made.attempts, 2);
  // the same with an older backup whose time Kinsta did not give
  const untimed = { id: 7, note: "before-update", type: "manual" };
  const k2 = kinsta([untimed], { appearAfterReads: 2 });
  const c2 = clock();
  const made2 = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: k2.fetcher,
    now: c2.now,
    wait: c2.wait,
  });
  assertEquals(made2.id, 99);
  assertEquals(made2.attempts, 2);
});

Deno.test("createBackup counts only manual backups, also when it finds one again", async () => {
  const k = kinsta([
    backupJson(5, "before-update", "manual", NOW - 60_000),
    backupJson(6, "Daily", "autodaily"),
    backupJson(7, "Daily", "autodaily"),
  ]);
  const made = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: k.fetcher,
    now: () => NOW,
    wait: noWait,
  });
  assertEquals(made.reused, true);
  assertEquals(made.manualCount, 1);
});

Deno.test("createBackup does not show or store an operation id that holds a piece of the key", async () => {
  for (
    const operation_id of [
      FAKE_KEY,
      `op-${FAKE_KEY.slice(4, 14)}`,
      "x".repeat(201),
    ]
  ) {
    const k = kinsta([], { post: { status: 202, body: { operation_id } } });
    const e = await assertRejects(() =>
      createBackup(FAKE_KEY, ENV, ARGS, {
        fetcher: k.fetcher,
        now: () => NOW,
        wait: noWait,
      })
    ) as Error;
    assertStringIncludes(e.message, "gave no usable operation id");
    assertStringIncludes(e.message, MAYBE_STARTED);
    assert(!e.message.includes(FAKE_KEY.slice(4, 12)));
    assertEquals(k.posts(), 1);
  }
  // the longest id that is accepted
  const ok = kinsta([], {
    post: { status: 202, body: { operation_id: "x".repeat(200) } },
  });
  const c = clock();
  const made = await createBackup(FAKE_KEY, ENV, ARGS, {
    fetcher: ok.fetcher,
    now: c.now,
    wait: c.wait,
  });
  assertEquals(made.operationId, "x".repeat(200));
});

Deno.test("createBackup stops waiting at once on a clear no, and says the request had been accepted", async () => {
  for (const status of [401, 403, 404]) {
    const k = kinsta([], {
      listError: (read) =>
        read > 1 ? { status, body: { message: "no" } } : null,
    });
    const c = clock();
    const e = await assertRejects(() =>
      createBackup(FAKE_KEY, ENV, ARGS, {
        fetcher: k.fetcher,
        now: c.now,
        wait: c.wait,
      })
    ) as Error;
    assertStringIncludes(e.message, `(HTTP ${status})`);
    assertStringIncludes(
      e.message,
      "Kinsta had accepted the backup request (operation backups:add-manual-abc123) before this",
    );
    assertEquals(k.reads(), 2, String(status));
    assertEquals(k.posts(), 1);
  }
  // any other refusal is ridden out until the wait is over
  const k = kinsta([], {
    listError: (read) =>
      read > 1 ? { status: 409, body: { message: "busy" } } : null,
  });
  const c = clock();
  await assertRejects(
    () =>
      createBackup(FAKE_KEY, ENV, { ...ARGS, waitMinutes: 1 }, {
        fetcher: k.fetcher,
        now: c.now,
        wait: c.wait,
      }),
    Error,
    "was listed within 1 min",
  );
  assertEquals(k.reads(), 1 + 4);
});

Deno.test("createBackup never sleeps past its deadline", async () => {
  const k = kinsta([], { appearAfterReads: 1e9 });
  const waits: number[] = [];
  let t = NOW;
  await assertRejects(
    () =>
      createBackup(
        FAKE_KEY,
        ENV,
        { ...ARGS, waitMinutes: 1, pollSeconds: 300 },
        {
          fetcher: k.fetcher,
          now: () => t,
          wait: (ms) => {
            waits.push(ms);
            t += ms;
            return Promise.resolve();
          },
        },
      ),
    Error,
    "was listed within 1 min",
  );
  assertEquals(waits, [60_000]);
  assertEquals(k.reads(), 2);
});

Deno.test("createBackup hands the cancel signal to the request and to every read after it", async () => {
  const real = globalThis.fetch;
  const stop = new AbortController();
  const seen: { method: string; joined: boolean }[] = [];
  let list: unknown[] = [];
  globalThis.fetch = ((_u: URL, init: RequestInit) => {
    // a request that carries the cancel signal aborts together with it
    const probe = new AbortController();
    const before = init.signal!.aborted;
    stop.signal.addEventListener("abort", () => probe.abort(), { once: true });
    seen.push({
      method: String(init.method),
      joined: !before && init.signal !== undefined,
    });
    if (init.method === "POST") {
      list = [backupJson(99, "before-update", "manual", Date.now())];
      return Promise.resolve(
        new Response('{"operation_id":"op-1"}', { status: 202 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(backupsJson(list))));
  }) as typeof fetch;
  const signals: AbortSignal[] = [];
  const realAny = AbortSignal.any;
  AbortSignal.any = ((all: AbortSignal[]) => {
    signals.push(all[0]);
    return realAny.call(AbortSignal, all);
  }) as typeof AbortSignal.any;
  try {
    await createBackup(FAKE_KEY, ENV, { ...ARGS, pollSeconds: 5 }, {
      cancel: stop.signal,
      wait: noWait,
    });
  } finally {
    globalThis.fetch = real;
    AbortSignal.any = realAny;
  }
  assertEquals(seen.map((s) => s.method), ["GET", "POST", "GET"]);
  // each of the three requests was joined with the same cancel signal
  assertEquals(signals.length, 3);
  for (const s of signals) assert(s === stop.signal);
});

Deno.test("nothing that holds a piece of the key is stored", async () => {
  const piece = FAKE_KEY.slice(6, 16);
  const cases: [keyof typeof model.methods, Record<string, unknown>, Route][] =
    [
      ["sites", {}, {
        body: sitesJson([siteJson({ display_name: `Shop ${piece}` })]),
      }],
      ["sites", {}, {
        body: sitesJson([
          siteJson({ site_labels: [{ name: FAKE_KEY.toUpperCase() }] }),
        ]),
      }],
      ["backups", { environmentId: ENV }, {
        body: backupsJson([backupJson(1, `note ${piece}`)]),
      }],
      ["backups", { environmentId: ENV }, {
        body: { environment: { display_name: piece, backups: [] } },
      }],
    ];
  for (const [method, args, route] of cases) {
    const real = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(route.body)),
      )) as typeof fetch;
    const written: unknown[] = [];
    try {
      const e = await assertRejects(() =>
        // deno-lint-ignore no-explicit-any
        (model.methods[method].execute as any)(args, {
          globalArgs: { apiKey: FAKE_KEY, companyId: COMPANY },
          logger: { info: () => {} },
          writeResource: (_s: string, name: string, data: unknown) => {
            written.push(data);
            return Promise.resolve({ name });
          },
        })
      ) as Error;
      assertStringIncludes(
        e.message,
        "piece of it (8 characters or more in a row); nothing was stored",
      );
    } finally {
      globalThis.fetch = real;
    }
    assertEquals(written, [], method);
  }
});

// ---------------------------------------------------------------- added after the final verification

Deno.test("readBody counts every chunk towards the cap", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(4));
      c.close();
    },
  });
  await assertRejects(() => readBody(new Response(stream), 10), BodyTooLarge);
});

Deno.test("kinstaFetch stops the download of a redirect answer and names only the host in a refusal", async () => {
  const real = globalThis.fetch;
  let cancelled = 0;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
        { status: 302, headers: { location: "https://evil.example/" } },
      ),
    )) as typeof fetch;
  try {
    const e = await assertRejects(() =>
      kinstaFetch(`${API}/sites`, GET)
    ) as Error;
    assertEquals(cancelled, 1);
    assert(!e.message.includes("evil.example"));
    const r = await assertRejects(() =>
      kinstaFetch("https://someone:secretpw@evil.example/v2/x?token=abc", GET)
    ) as Error;
    assertEquals(
      r.message,
      "refusing a request outside the Kinsta API: evil.example",
    );
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("create_backup stores nothing that holds a piece of the key either", async () => {
  const piece = FAKE_KEY.slice(6, 16);
  const real = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(backupsJson([{
        id: 5,
        name: `backup ${piece}`,
        note: "before-update",
        type: "manual",
        created_at: Date.now() - 60_000,
      }]))),
    )) as typeof fetch;
  const written: unknown[] = [];
  try {
    const e = await assertRejects(() =>
      // deno-lint-ignore no-explicit-any
      (model.methods.create_backup.execute as any)({ ...ARGS }, {
        globalArgs: { apiKey: FAKE_KEY, companyId: COMPANY },
        logger: { info: () => {} },
        writeResource: (_s: string, name: string, data: unknown) => {
          written.push(data);
          return Promise.resolve({ name });
        },
      })
    ) as Error;
    assertStringIncludes(e.message, "nothing was stored");
    assertStringIncludes(e.message, "make a new key");
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(written, []);
});

Deno.test("a key spread out with spaces inside a name is not stored", async () => {
  const spaced = FAKE_KEY.match(/.{1,7}/g)!.join(" ");
  const real = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify(sitesJson([siteJson({ display_name: spaced })])),
      ),
    )) as typeof fetch;
  const written: unknown[] = [];
  try {
    const e = await assertRejects(() =>
      // deno-lint-ignore no-explicit-any
      (model.methods.sites.execute as any)({}, {
        globalArgs: { apiKey: FAKE_KEY, companyId: COMPANY },
        logger: { info: () => {} },
        writeResource: (_s: string, name: string, data: unknown) => {
          written.push(data);
          return Promise.resolve({ name });
        },
      })
    ) as Error;
    assertStringIncludes(e.message, "nothing was stored");
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(written, []);
});

Deno.test("an error after the request always says the request had been accepted", async () => {
  const said =
    "Kinsta had accepted the backup request (operation backups:add-manual-abc123) before this";
  // cancelled during the wait between two reads
  const k = kinsta([]);
  const a = await assertRejects(() =>
    createBackup(FAKE_KEY, ENV, ARGS, {
      fetcher: k.fetcher,
      now: () => NOW,
      wait: () => Promise.reject(new Error("stop")),
    })
  ) as Error;
  assertEquals(
    a.message.startsWith("cancelled: stop. " + said),
    true,
    a.message,
  );
  // cancelled during a read: the word is not doubled
  const stop = new AbortController();
  let reads = 0;
  const raw = fake((req) => {
    if (req.method === "POST") {
      return {
        status: 202,
        body: { operation_id: "backups:add-manual-abc123" },
      };
    }
    if (++reads === 1) return { body: backupsJson([]) };
    stop.abort(new Error("stop"));
    return new Error("aborted");
  });
  const b = await assertRejects(() =>
    createBackup(FAKE_KEY, ENV, ARGS, {
      fetcher: raw.fetcher,
      now: () => NOW,
      wait: noWait,
      cancel: stop.signal,
    })
  ) as Error;
  assertEquals(
    b.message.startsWith("cancelled: aborted. " + said),
    true,
    b.message,
  );
  assert(!b.message.includes("cancelled: cancelled"));
  // a refusal that is not a clear no (429, 500) keeps the wait going
  for (const status of [429, 500]) {
    const busy = kinsta([], {
      appearAfterReads: 1e9,
      listError: (read) =>
        read > 1 ? { status, body: { message: "later" } } : null,
    });
    const c = clock();
    await assertRejects(
      () =>
        createBackup(FAKE_KEY, ENV, {
          ...ARGS,
          waitMinutes: 1,
          pollSeconds: 30,
        }, {
          fetcher: busy.fetcher,
          now: c.now,
          wait: c.wait,
        }),
      Error,
      "was listed within 1 min",
    );
  }
});
