# ACL4SSR Rules For sing-box

These rule sets are adapted from [ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)
and distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The upstream [license](https://github.com/ACL4SSR/ACL4SSR/blob/433381ebc4b1de59350fa8bed2a04a888228f801/LICENCE)
applies to the adapted rule data. MiSub's application license is separate.

Revision directories identify the upstream snapshot. Original list comments and
`no-resolve` modifiers are omitted; supported matches are converted into sing-box
source JSON version 1. Entries of the same match type share an array, and different
match dimensions remain independent OR alternatives. Unsupported URL-REGEX and
USER-AGENT entries are omitted and counted in the generated manifest.

`shared/singbox-ruleset-manifest.js` records source/output SHA-256 hashes, converted
counts and omitted types for each file. The application requires sing-box >=1.12.
Retain older revision directories while existing subscriptions may reference them.

To refresh a snapshot, run `scripts/fetch-singbox-rulesets.ps1 -OutputPath <snapshot.json>`
using tinyfish, then `node scripts/build-singbox-rulesets.mjs --source-file <snapshot.json>`.
Use `--dry-run` to inspect the conversion report or `--check` to verify existing artifacts.
Normal Vite builds use the checked-in artifacts without downloading rules.
