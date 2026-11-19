# @jayr/wporg-plugin

Watch a plugin on the WordPress.org directory, and confirm WordPress.org serves a release after you ship it.

It is read-only and needs no account, token or secret. Every request is an anonymous GET to `api.wordpress.org`,
`plugins.svn.wordpress.org` or `downloads.wordpress.org`. It never writes to WordPress.org, SVN or git: shipping stays
with a person.

## Methods

| Method | What it does |
| --- | --- |
| `sync` | Reads the plugin's directory listing and SVN trunk and flags what is out of date or could not be read. Writes a `listing` resource with `status` `ok`, `warn` or `fail`. The run itself succeeds whatever the status. |
| `verify_release` | Polls WordPress.org until a version is served: directory version, SVN tag folder, trunk Stable tag and the download zip. Writes a `releaseVerify` resource. The run **fails** when the version is not served within `waitMinutes`. |

## Use

```bash
swamp extension pull @jayr/wporg-plugin
swamp model create @jayr/wporg-plugin my-plugin --global-arg slug=hello-dolly
swamp model method run my-plugin sync
swamp model method run my-plugin verify_release --input version=1.7.2 --input waitMinutes=0
```

`sync` prints each flag in the run log. To read the stored result:

```bash
swamp data query 'modelName == "my-plugin" && name == "listing"' --select content
```

A definition looks like this:

```yaml
globalArguments:
  slug: hello-dolly
  role: owner                  # owner, committer, contributor or watch (default); a label only
  repo: your-org/hello-dolly   # optional; a label only
```

Arguments:

| Method | Argument | Default | Meaning |
| --- | --- | --- | --- |
| `sync` | `staleDays` | 180 | Warn when the last update on WordPress.org is older than this. |
| `sync` | `maxUnresolved` | 5 | Warn when more support threads than this are unresolved. Up to this many is an info flag. |
| `verify_release` | `version` | required | The version that should now be served, exactly as tagged. It must start with a digit. |
| `verify_release` | `waitMinutes` | 30 | How long to keep polling (0 to 120). 0 checks once. |
| `verify_release` | `pollSeconds` | 60 | Seconds between polls (30 to 3600). Attempts are about `waitMinutes × 60 ÷ pollSeconds`. |

### Using `sync` as a gate

`sync` succeeds even when the stored `status` is `fail` (a closed plugin), so that a daily watch keeps recording. To stop
a workflow on it, test the stored value in a later step:

```
data.latest("my-plugin", "listing").attributes.status == "ok"
```

## Flags from `sync`

`status` is `fail` when any flag is `fail`, else `warn` when any flag is `warn`, else `ok`.

| Code | Severity | Meaning |
| --- | --- | --- |
| `closed` | fail | The plugin is closed on WordPress.org. The date and reason are stored when WordPress.org gives them. |
| `not_listed` | warn | WordPress.org answered its exact "Plugin not found." (in review, never submitted, or a typo in the slug). |
| `version_unreadable` | warn | The version the directory serves does not look like a version, so it was not stored or compared. |
| `wp_tested_behind` | warn | "Tested up to" is an older major.minor than the current WordPress. |
| `wp_tested_unreadable` | warn | "Tested up to" is missing or not a version, so it could not be compared. |
| `wc_tested_behind` | warn | "WC tested up to" is an older major.minor than the current WooCommerce. |
| `wc_tested_unchecked` | warn | "WC tested up to" could not be compared (not a version, or WooCommerce's version could not be read). |
| `stale` | warn | The last update is older than `staleDays`. WordPress.org's date also moves on a readme-only change. |
| `last_update_unknown` | info | The date of the last update could not be read. |
| `support_unresolved` | info or warn | Unresolved support threads in the last two months; warn above `maxUnresolved`. |
| `support_unknown` | info | The support thread counts could not be read. |
| `stable_tag_missing` | warn | No usable Stable tag in trunk's `readme.txt` or `readme.md`: no such file, no Stable tag in its first 8 KiB, or not version-like. |
| `stable_tag_mismatch` | warn | Trunk's Stable tag differs from the version the directory serves. |
| `stable_tag_trunk` | info | Trunk's Stable tag is `trunk`. |
| `main_file_unread` | warn | No plugin header with a readable Version was found in trunk, so trunk's version was not compared. When no header was found at all, WooCommerce support was not checked either. |
| `trunk_unreleased` | info | Trunk's plugin header version differs from the released version. |

## Limits you should know

- **The main plugin file** is looked for among the root `.php` files of trunk: `<slug>.php` first, then the others in
  listing order, 20 files at most in total, so `sync` makes at most 26 requests. File names with characters outside letters, digits, `.`,
  `_` and `-` are skipped. When it is not found you get `main_file_unread`, never a quiet pass.
- **WooCommerce** is checked only when the main file has a "WC tested up to" header, and that header is read from
  **trunk**, while "Tested up to" comes from the directory (the released version). A header bumped in trunk but not yet
  released passes.
- **`verify_release` needs a numbered Stable tag.** It cannot pass for a plugin whose Stable tag is `trunk`, or whose
  tag folder is named differently from the version the directory reports (tag `1.0`, header `1.0.0`).
- **`verify_release` does not check what is inside the zip.** It checks that a zip file is served for the version, not
  that it holds the files you shipped. It is a "WordPress.org has caught up" check, not a release audit.
- Each `verify_release` attempt requests the release zip and stops after its first bytes. WordPress.org may still count
  that request in its download statistics.
- **The trunk readme** must be named `readme.txt` or `readme.md` in lower case.
- Versions and tags are stored only when they look like one: the first word of the value, starting with a digit, made of
  letters, digits and `. + _ ~ -`, up to 40 characters, or the word `trunk`. Anything else is treated as missing. A value
  such as `1.example.com` is version-shaped and passes, so do not assume a stored version cannot look like a domain.

## It fails closed

- `sync` accepts three answers from the plugin API: a listing for this slug, WordPress.org's exact "Plugin not found."
  and its "closed" answer. Anything else (a server error, another error text, a listing for another plugin) stops the
  run with an error and records nothing.
- When SVN answers with a server error, a redirect or a timeout, `sync` stops with an error and records nothing. When
  SVN answers "not found" or with a page that holds no readme or plugin header, `sync` records a `warn` flag.
- A version-like value that cannot be compared becomes a `warn` flag. Two things `sync` could not read are only `info`
  flags and leave `status` at `ok`: the date of the last update and the support thread counts.
- `verify_release` passes only when all four checks pass. A page that answers 200 but is not that tag's folder page, or
  a download that is not a zip, does not count.
- `verify_release` retries through a WordPress.org error while it polls. If the last attempt still cannot read
  WordPress.org, the run fails and nothing is recorded.

## What it does on your machine

- It reads no local file, writes no file and starts no other program. Results are written only through swamp's own
  data store.
- Network: anonymous HTTPS GETs to the three WordPress.org hosts only. 30 second timeout, redirects are refused, at most
  1 MB is read from any answer, and reading stops after the first 8 KiB of a readme or PHP file. Polling is never faster
  than every 30 seconds.
- It sends nothing about you: no token, no cookie, and a fixed User-Agent that names this extension.
- Text from WordPress.org is treated as data. Control and text-direction characters, zero-width and other characters
  Unicode marks as invisible, private-use characters and line breaks are removed, and each value is cut to 200
  characters before it is logged or stored. Only the plugin's display name and a closure reason are kept as free text;
  they are **not** escaped for HTML or chat and can contain a link, so escape them where you display them.
- Stored results hold public plugin metadata and the three labels you set (`slug`, `role`, `repo`). The labels stay in
  your own datastore and are never sent anywhere.
- Its only dependency is `zod`, which swamp itself provides; nothing else is bundled or downloaded.

It does not check a build before you ship, verify that you own the plugin, check licences, or replace a review.

## Requirements

Outbound HTTPS to `api.wordpress.org`, `plugins.svn.wordpress.org` and `downloads.wordpress.org`.

## Security

See `SECURITY.md` in this package for how to report a problem privately.

## License

MIT
