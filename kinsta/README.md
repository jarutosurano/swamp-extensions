# @jayr/kinsta

List the sites, environments and backups of a Kinsta company, and take a manual backup before a risky change.

It is deliberately small. It can read, and it can ask for one manual backup. It has no code that restores a backup,
deletes one, pushes an environment or changes a site.

This is an independent extension. It is not made or supported by Kinsta.

## Methods

| Method | What it does |
| --- | --- |
| `sites` | Lists every site of the company with its environments. One GET, repeated only when it fails. Writes a `sites` resource. |
| `backups` | Lists the backups of one environment, manual and automatic. One GET, repeated only when it fails. Writes a `backups-<environment id>` resource. |
| `create_backup` | Asks Kinsta for one manual backup of one environment, then reads the backup list until the new backup is there. Writes a `backup-<environment id>` resource. The run **fails** when the backup is not listed within `waitMinutes`. |

## Set up

You need a Kinsta API key (MyKinsta > your name > Company settings > API Keys) and your company id (MyKinsta > your
name > Company settings > Billing details).

A Kinsta key can act on every site its owner can reach, which is often the whole company. Keep it in a vault and never
write it in a definition, a command or a chat. Store it with the hidden prompt:

```bash
swamp extension pull @jayr/kinsta
swamp vault put default kinsta-api-key
```

`swamp vault put` asks for the value without showing it. Then create a definition and point `apiKey` at the vault:

```yaml
globalArguments:
  apiKey: ${{ vault.get(default, kinsta-api-key) }}
  companyId: 00000000-0000-4000-8000-000000000000
```

## Use

```bash
swamp model method run my-kinsta sites
swamp model method run my-kinsta backups --input environmentId=00000000-0000-4000-8000-000000000001
swamp model method run my-kinsta create_backup \
  --input environmentId=00000000-0000-4000-8000-000000000001 --input tag=before-plugin-update
```

`sites` gives you the environment ids the other two methods need. To read a stored result:

```bash
swamp data query 'modelName == "my-kinsta" && name == "sites"' --select content
```

In a workflow, a later step can use the backup that was just made:

```
data.latest("my-kinsta", "backup-00000000-0000-4000-8000-000000000001").attributes.id
```

### Arguments of `create_backup`

| Argument | Default | Meaning |
| --- | --- | --- |
| `environmentId` | required | The environment to back up, a UUID. |
| `tag` | required | The note Kinsta shows on the backup. Lowercase letters, digits and single hyphens, 40 characters at most. |
| `waitMinutes` | 15 | About how long to wait for Kinsta to list the new backup (1 to 60). A slow or failing answer from Kinsta to the last read can add up to about six minutes. |
| `pollSeconds` | 15 | Seconds between two reads of the backup list while waiting (5 to 300). |
| `manualLimit` | 5 | How many manual backups Kinsta keeps for one environment. Change it only if your account's limit is not 5. |
| `whenFull` | `refuse` | At the limit: `refuse` asks for nothing and fails. `proceed` asks anyway. |
| `reuseWithinMinutes` | 60 | A manual backup with the same tag this recent is recorded instead of asking for another. `0` always asks. Keep it longer than `waitMinutes`. |

## What `create_backup` promises, and what it does not

- **It asks once.** The request is sent exactly once in one run. It is not sent again after a network error, a server
  error or a "too many requests" answer.
- **When the request did not end cleanly, it says so.** After a network error, a time-out, a server error or an answer
  it cannot read, nobody knows whether Kinsta started the backup. The error then ends with "The request may have
  reached Kinsta: run the backups method or check MyKinsta before asking again". A clear refusal (a 4xx answer in Kinsta's own
  JSON form) does not carry that sentence.
- **A second run finds the first run's backup again.** When a run timed out or was cancelled, run it again: if Kinsta
  made the backup in the last `reuseWithinMinutes` (60 by default), that backup is recorded (`reused: true`) and
  nothing new is requested. Anyone's manual backup with the same tag counts, so give each purpose its own tag. Two
  runs started at the same moment can still both ask.
- **It refuses at the limit by default.** Kinsta keeps a limited number of manual backups for one environment. This
  extension has not tested what Kinsta does when you ask for one more, so it does not ask unless you pass
  `whenFull=proceed`.
- **It only reports a backup Kinsta lists.** Success means Kinsta's own list holds a manual backup with your tag, an
  id that was not there before the request and, when Kinsta gives its time, a time no more than five minutes before
  the request. The five minutes allow for a difference between your clock and Kinsta's. If your clock is more than
  five minutes ahead, the new backup is not recognised and the run times out; a second run then finds it. An
  accepted request alone is not success. Being listed is all it checks: it does not ask Kinsta whether the backup has
  finished being written.
- **It does not check what is inside the backup,** and it cannot restore one. Restoring stays with a person in
  MyKinsta.
- **A time-out is not proof of failure.** The error gives Kinsta's operation id. The backup may still appear: check
  MyKinsta, or run `backups`.

## It fails closed

- Any answer that is not what was asked for stops the run with an error and records nothing: a wrong key, an unknown
  company or environment, a server error, a redirect, an answer that is not JSON or does not hold the list.
- A site, environment or backup without a usable id stops the run. Nothing is guessed.
- The one exception is the wait inside `create_backup`: once Kinsta has accepted the request, a backup list that
  cannot be read is tried again at the next poll, until the backup is listed or the wait runs out. A clear "no" (wrong
  key, no access, no such environment) still stops the run at once.
- A read is repeated twice after a network error, an answer that breaks off or stops half-way, or a server error. On a read, "too many
  requests" is waited out up to three times, using Kinsta's `Retry-After` (60 seconds at most each).
- Ids are checked to be UUIDs before they go into a request URL.

## What it does on your machine

- **Network:** HTTPS requests to `api.kinsta.com` only, under `/v2/`. Every other host is refused, redirects are never
  followed, each request has a 30 second timeout, and at most 10 MB is read from an answer. The three requests it can
  make are: list sites, list backups, create a manual backup.
- **The API key** is sent in the `Authorization` header of those requests and goes nowhere else. It is not logged and
  not written to a resource. Every error message is filtered first: the key and any piece of it of 8 characters or
  more is replaced by `[api key]`, and a text that still holds a piece once its spaces and line breaks are closed up is
  not shown at all. Should Kinsta ever send the key, or 8 characters of it in a row, back inside a name, a note or an operation id, nothing
  is stored and the run fails. It is marked sensitive, so swamp shows it as `***` and keeps the vault reference,
  not the key, in stored definitions. The extension never prints or stores request headers.
- **What is stored**, in your own swamp datastore only: your company id; site id, name, display name, status and
  labels; environment id, name, display name, premium and blocked flags, primary domain, WordPress version and PHP
  version; backup id, name, note, type and time, with the environment's name; for `create_backup` also your tag, Kinsta's
  operation id, whether the backup was found again and how many reads it took; counts and the time of the check. Site names and domains are your company's data: treat the stored resources accordingly.
- **What is dropped** and never stored or logged, although Kinsta sends it: the SSH host and port, the web root path,
  cache and container ids and the full domain list.
- Text from Kinsta is treated as data. Control and text-direction characters, zero-width and other invisible
  characters and line breaks are each replaced by a space, the opening of a swamp expression is broken up, and each
  text value is cut to 200 characters. A primary domain is kept only when it is shaped like a host name of at most 253
  characters, and a version only when it is one word of at most 40. Site names, labels and backup notes are kept as
  free text; they are **not** escaped for HTML or chat, so escape them where you display them.
- If `create_backup` refuses to store its result for that reason, the backup itself may already exist at Kinsta: run
  `backups` to see it.
- It reads no local file, writes no file and starts no other program.
- Its only dependency is `zod`, which swamp itself provides; nothing else is bundled or downloaded.

## Limits you should know

- A company's whole site list comes in one answer. More than 5,000 sites, 100 environments on one site or 2,000
  backups on one environment stop the run.
- `tag` is narrower than what Kinsta accepts, on purpose: the extension recognises its own backup by an exact match of
  the tag, so it only sends tags that come back unchanged.
- The time of a backup is stored only when Kinsta gives it as a millisecond timestamp; otherwise it is `null`, and
  such a backup is never treated as "recent".
- It does not read the status of Kinsta's operation. It trusts the backup list instead.

## Requirements

Outbound HTTPS to `api.kinsta.com`, and a Kinsta API key with access to the company.

Kinsta and MyKinsta are trademarks of Kinsta Inc. They are used here only to say what this extension works with.

## Security

See `SECURITY.md` in this package for how to report a problem privately and what to do if a key may have leaked.

## License

MIT
