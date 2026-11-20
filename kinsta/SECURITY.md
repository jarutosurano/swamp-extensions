# Security

This extension handles a Kinsta API key. A Kinsta key can act on every site its owner can reach, which is often the
whole company, so treat it like a password.

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private report form:
https://github.com/jarutosurano/swamp-extensions/security/advisories/new

Say which version (it is in the manifest and in `swamp extension` output), what you saw and how to reproduce it. Never
paste a real API key, company id or site name into a report. You should get a first answer within a week.

## What it is allowed to do

The README section "What it does on your machine" lists the one host it talks to and the three requests it makes. It
reads no local file and starts no program. It has no code that restores, deletes or pushes. Anything outside that is a
bug worth reporting.

## If a key may have leaked

Revoke it in MyKinsta (your name > Company settings > API Keys) and create a new one. Then put the new key in your vault. Nothing
in this extension needs to change.

## Supported versions

Only the latest published version receives fixes. Reports about older versions are still welcome: say which one.
