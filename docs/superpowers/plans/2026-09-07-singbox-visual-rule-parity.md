# sing-box visual rule parity implementation plan

> Execution: `superpowers:executing-plans`, in the existing `test` branch.

**Goal:** Make built-in visual remote rule sources consumable by sing-box without changing their selected content or the other five renderers.

**Architecture:** Convert a local base64 snapshot of the pinned ACL4SSR revision into versioned static source JSON. A generated manifest restricts URL mapping to published files and records provenance. Share the basic headless rule mapping with the sing-box renderer; retain URL-derived tags. Use upstream official formats for the two additional ad lists.

**Tech Stack:** Existing JavaScript ES modules, Node built-ins, Vitest, Vite. No new dependencies or CI/build configuration changes.

**Spec:** `docs/superpowers/specs/2026-09-05-singbox-visual-rule-parity.md`, especially the 2026-09-07 implementation review.

## Constraints

- L3: complete red-green testing for conversion and rendering contracts. Minimum supported sing-box version: 1.12.
- Work in `test`; preserve the user's existing spec edits. No worktree, push, merge or deletion. The user explicitly authorized the final local commit after verification.
- Offline conversion command: `node scripts/build-singbox-rulesets.mjs --source-file <snapshot.json>`. All inputs are parsed before output is written.
- Batch creation of static JSON, the generated manifest and generated-file attributes received operation-specific user authorization before execution.
- `tinyfish` preserves GitHub API base64 losslessly, including the git blob fallback for files over 1 MB. The snapshot is verified against file size and Git blob SHA. The official client download tool exception also received explicit user authorization.

## Task 1: Offline Conversion

Files: create `shared/singbox-rule.js`, `scripts/build-singbox-rulesets.mjs`, `scripts/fetch-singbox-rulesets.ps1`, `tests/unit/singbox-ruleset-build.test.js`.

Interfaces: `toSingboxHeadlessRule(type, value)` returns one match object or null for unsupported types. `convertRuleList(text)` returns `{ ruleSet, converted, skipped }`. `getAclSources()` discovers catalog/LAN sources. `buildRuleSetArtifacts(snapshot)` validates all source bytes and returns deterministic artifacts and a manifest without writing.

- [x] Check prerequisite tests: four files / 111 tests passed.
- [x] Add failing conversion tests for each supported field, OR semantics, BOM/CRLF/comments, modifiers, unknown types, malformed port/IP values and empty output.
- [x] Implement conversion, preserving OR alternatives while grouping identical match dimensions. Known unsupported types are counted; unknown or malformed records fail with line context.
- [x] Build the offline CLI using Node filesystem/crypto APIs; discover sources from `BUILTIN_CARDS` and `LOCAL_AREA_NETWORK_SOURCE`, and use the pinned revision in output paths/provenance.
- [x] Run `npx vitest run tests/unit/singbox-ruleset-build.test.js`: 30 tests passed after red-green cycles, including prototype names, scoped IPv6 and leading-zero CIDR prefixes.
- [x] Download all 68 sources using tinyfish/API base64 and verify actual input: 97,400 converted, 10 URL-REGEX omitted across four lists, 2,947,292 output bytes. Attach CC BY-SA 4.0 attribution in public README.
- [x] Obtain authorization and generate the manifest and 68 static JSON files; verify all 69 outputs with `--check`. Add the authorized `.gitattributes` generated-file markers.

## Task 2: Mapping and Renderer

Files: create `shared/singbox-ruleset-map.js`, generated `shared/singbox-ruleset-manifest.js`, `public/rulesets/singbox/<revision>/*.json`; modify `functions/modules/subscription/template-renderers/render-singbox.js`; add `tests/unit/singbox-ruleset-map.test.js`; extend `tests/unit/rule-generator-render-matrix.test.js`.

Interfaces: `toSingboxRuleSetUrl(sourceUrl, { origin })` returns a mapped URL or null. `getSingboxRuleSetFormat(sourceUrl)` inspects pathname, returning binary for .srs and source otherwise. The manifest records revision and each file's source/output hashes and skipped counts.

- [x] Capture additional byte baselines with a nonempty managed URL before renderer edits; all five passed.
- [x] Add failing tests for exact hosts, unknown paths, query/hash, missing/invalid origin, pinned inputs, official ads, unchanged tags and references.
- [x] Implement manifest-constrained ACL mapping and exact ad mappings. Use options or model settings for the managed origin. Keep unknown URLs on the existing pass-through path.
- [x] Reuse the tested basic rule mapper for inline rules; preserve existing GEOIP/GEOSITE/RULE-SET handling and error behavior.
- [x] Verify every catalog ACL source is represented by a valid static JSON file; check hashes and current revision. Mapping, renderer and converter suites pass, including both byte baselines for the other five renderers.

## Task 3: Compatibility Warnings

Files: modify `src/utils/rule-generator/validate.js` and `tests/unit/rule-generator-validate.test.js`.

- [x] Add failing warning tests for active unmapped .list/.txt and unknown extensions; mapped URLs and native .json/.srs produce no sing-box warning. Cover user and edited built-in cards, off/trash and nested sources.
- [x] Use the shared mapping/format checks for warnings attached to the actual source field. Keep warnings nonblocking and distinguish incompatibility, unknown content and partial conversion.
- [x] Run validation and modal suites; warnings are visible and do not block applying the generated template.
- [x] Check the built page in Edge with Playwright at 1440x1000 and 390x844. All three warning categories appear, native JSON/SRS has no sing-box warning, text has no horizontal overflow and applying the template succeeds. API fixtures stay inside the test browser; no production data is accessed or changed. Stable screenshots were visually reviewed, with no page JavaScript errors.

## Task 4: Verification

- [x] Inspect real-input skip counts and retain manifest provenance. Verify one rule per match dimension; never join different dimensions with unintended AND semantics.
- [x] Independent review identified legacy `rulesets` token/login collisions and CIDR parser differences. Add strict public asset routing in `functions/[[path]].js` and `tests/unit/singbox-ruleset-assets.test.js`; five regressions failed before the fix, all six pass after it. Fix the CIDR inputs with red-green tests.
- [x] Verify actual Vite HTTP delivery returns 200 and application/json without authentication. The entry-point regressions cover ASSETS/Pages next() and legacy token/login collisions.
- [x] Verify `dist` includes exactly the current revision's 68 expected JSON files, with matching SHA-256 hashes. Fetch all 68 through Vite preview and confirm HTTP 200, application/json and matching response hashes. Rerun both native clients with `--public-dir dist`; all checks pass.
- [x] Run `npx vitest run`: 133 files / 1,066 tests passed.
- [x] Complete `npm run build` after the user authorized a serial retry through one sub-agent. Automatic approval succeeded; Vite 7.3.3 built 326 modules in 9.10 seconds, exit code 0. No dependencies, build config or CI changed.
- [x] Review implementation against the spec and correct required findings. Independently review the native smoke script; reproduce and fix unbounded process cleanup, then rerun both clients.
- [x] Download and SHA-256-verify official sing-box 1.12.0 / 1.13.0 after authorization; both compile all 68 actual JSONs. Both pass local configuration checks, download all 68 files, allow a loopback HTTP control request and log the exact Claude rule-set rejection. Raw .list input causes a nonzero FATAL parse failure in both. No proprietary clients were tested.
- [x] Update spec/plan with changed files, verified results and compatibility limits. Full tests, production build, both native clients, artifact reproducibility, script syntax, browser verification and `git diff --check` pass. Leave the branch and workspace in place, with no integration action performed.

## Verification State (2026-09-08)

- Source snapshot: `$env:TEMP/misub-singbox-433381eb-snapshot.json`. Conversion produced 97,400 supported records across 68 files and reported 10 omitted URL-REGEX records across four lists. Static JSON totals 2,947,292 bytes; provenance and CC BY-SA 4.0 attribution are present.
- Both official clients are retained under `$env:TEMP/misub-singbox-clients`. SHA-256: 1.12.0 `49a5b90b390974a87b4660308446dfd9630f60ac655f76383abbd5f0994b09b3`; 1.13.0 `c080ac4f53f1e92fe44a5440958bfe6ff6a3db75347fe6b31afc6d6517a8d76e`. Node fetch completed the authorized downloads after Invoke-WebRequest failed with a Windows SSPI credentials error. No installation, PATH changes or TUN startup occurred.
- Repeat native checks with `node scripts/smoke-singbox-rulesets.mjs --client <1.12 executable> --client <1.13 executable>`. Temp configurations and logs are retained; all test-owned clients and HTTP servers are closed. The script bounds process shutdown and handles interruption.
- Previously blocked verification is complete: production build, all 68 hashes and HTTP responses from `dist`, native consumption of `dist`, and desktop/mobile browser checks. The user-requested single-sub-agent serial execution was followed throughout the retry.
- Native `dist` run logs: `$env:TEMP/misub-singbox-smoke-jwVWfQ`. Stable browser screenshots: `$env:TEMP/misub-rule-browser-I7Da6B/warnings-1440.png` and `warnings-390.png`. The browser test uses fixtures and leaves the existing INI character validation intact.
- Static preview is retained at `http://127.0.0.1:4173/` without a backend. All verification browsers and native clients are closed. Remaining compatibility limits are the documented omitted URL-REGEX conditions and unconverted custom text sources; proprietary clients are unavailable locally.
- No implementation authorization remains pending. The final local commit to `test` is explicitly authorized; no push or merge is included.

## Files Changed So Far

- `docs/superpowers/specs/2026-09-05-singbox-visual-rule-parity.md` (preserves the user's pre-existing changes)
- `docs/superpowers/plans/2026-09-07-singbox-visual-rule-parity.md`
- `scripts/build-singbox-rulesets.mjs`
- `scripts/fetch-singbox-rulesets.ps1`
- `scripts/smoke-singbox-rulesets.mjs`
- `shared/singbox-rule.js`
- `shared/singbox-ruleset-map.js`
- `shared/singbox-ruleset-manifest.js` (generated)
- `functions/modules/subscription/template-renderers/render-singbox.js`
- `functions/[[path]].js`
- `src/utils/rule-generator/validate.js`
- `public/rulesets/singbox/README.md`
- `public/rulesets/singbox/433381ebc4b1de59350fa8bed2a04a888228f801/*.json` and `Ruleset/*.json` (68 generated files)
- `.gitattributes`
- `tests/unit/singbox-ruleset-build.test.js`
- `tests/unit/singbox-ruleset-map.test.js`
- `tests/unit/singbox-ruleset-assets.test.js`
- `tests/unit/rule-generator-render-matrix.test.js`
- `tests/unit/rule-generator-validate.test.js`
- `tests/unit/rule-generator-modal.test.js`
