# Security

This extension is small and reads its inputs defensively, but mistakes happen.

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private report form:
https://github.com/jarutosurano/swamp-extensions/security/advisories/new

Say which version (it is in the manifest and in `swamp extension` output), what you saw and how to reproduce it. You should get a first answer within a week.

## What it is allowed to do

The README section "What it does on your machine" lists the hosts it talks to. It reads no local file and starts no
program. Anything outside that is a bug worth reporting.

## Supported versions

Only the latest published version receives fixes. Reports about older versions are still welcome: say which one.
