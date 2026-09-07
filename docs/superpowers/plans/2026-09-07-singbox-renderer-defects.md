# sing-box renderer defects implementation plan

> Execution: `superpowers:executing-plans`, in the existing `test` branch.

**Goal:** Repair the five renderer defects in the reviewed spec while preserving rejection semantics and the other five renderers' outputs.

**Architecture:** Keep rule mapping and remote definitions inside the sing-box template renderer. Use a small sing-box-only helper to resolve rejection policies before pruning group members in both generators. Do not mutate the shared template model or shared policy factories.

**Tech Stack:** JavaScript ES modules, Vitest, existing Node tooling.

**Spec:** `docs/superpowers/specs/2026-09-05-pr-singbox-renderer-defects.md`

## Constraints

- User approved local branch `test` and updated the minimum supported version to sing-box >=1.12, matching the existing DNS format.
- L3: route rejection and client compatibility require red-green regression tests.
- No dependency, remote rule source, environment, or CI changes. The user has authorized a local commit on `test`; no remote Git operation is authorized.
- Preserve byte baselines for clash / surge / loon / quanx / egern.
- Keep the existing typed DNS servers and `route.default_domain_resolver`, both available since 1.12. Versions before 1.12 are out of scope; do not add legacy DNS output or version selection.

## Task 1: Reject Policies

- [x] Baseline: the original 34 focused tests pass; the added regressions fail on block outbounds, wrong FINAL, missing DOMAIN, and missing remote definitions.
- [x] Add regressions for direct REJECT / REJECT-DROP, nested reject-first selectors, allow-first selectors, empty-group pruning, and built-in ADS routing for std / full / relay.
- [x] Add `functions/modules/subscription/singbox-routing.js`: `prepareSingboxGroups(groups)` returns cleaned native sing-box groups and `resolveAction(policy)`. Resolve defaults to a fixed point before stripping literal rejects; recursively remove references to empty groups. REJECT-DROP yields `{ action: 'reject', method: 'drop' }`.
- [x] Connect both renderers; eliminate the legacy block outbound. Set `default` only on selector groups. Preserve REJECT-DROP through the sing-box INI processor without changing the other targets.
- [x] Run focused rejection regressions in both suites and confirm green.

## Task 2: FINAL and Remote References

- [x] Add first-FINAL, trailing-unreachable-rule, reject-FINAL, no-FINAL, URL-without-source, invalid-URL, and cross-policy duplicate URL tests.
- [x] Stop at the first MATCH / FINAL. A normal final target sets `route.final`; a rejecting final becomes a terminal reject action. Never use a removed group as `route.final`.
- [x] Use `pinRemoteRuleUrl()` consistently before deriving a URL-only tag; build remote definitions with a URL-keyed Map. Reject undeclared non-URL references explicitly rather than emitting dangling references.
- [x] Run focused regressions; assert every route and DNS rule-set reference has a definition.

## Task 3: Inline Rules

- [x] Test the nine offered inline types through all six renderers, with exact sing-box rule shapes.
- [x] Add DOMAIN, IP-CIDR / IP-CIDR6, PROCESS-NAME and numeric DST-PORT mappings; warn on unknown types.
- [x] Test invalid, fractional, negative, empty and out-of-range ports. Raise an explicit rendering error rather than emitting JSON null or silently dropping an intended rule.
- [x] Run the three renderer suites together with the pipeline, built-in rule audit and DNS toggle suites: 6 files / 143 tests pass.

## Task 4: Verification and Handoff

- [x] Review the diff and the spec checklist; correct review findings. Six new regressions first failed, then passed: prune reject-default selectors from urltest candidates and reject references to removed non-reject groups. Independent re-review closed both findings.
- [x] Run `npx vitest run` and `npm run build`: 130 files / 977 tests pass; build passes after retrying outside the sandbox's esbuild `spawn EPERM` restriction.
- [ ] Check actual sing-box binaries when available, including 1.12 and >=1.13; record exact limitations if binaries cannot be obtained using authorized tools. Version 1.11 is no longer an acceptance target.
- [x] Update the spec with review corrections, validation results and residual risks. Keep changes on `test`; the user subsequently authorized a local commit.

## Pending Decisions

- No sing-box executable was found locally. Permission to download official Windows binaries into a temporary directory using `Invoke-WebRequest` / `Expand-Archive` was requested but has not been granted. No real-client `sing-box check` has run.
- The DNS compatibility decision is resolved: the user approved >=1.12, so no DNS implementation changes are needed. `safe-dns.js` remains unchanged.
- A local commit of this task's files on `test` is authorized. Do not push, open a PR, merge, or remove the branch/workspace.

## Changed Files

- `functions/modules/subscription/singbox-routing.js`
- `functions/modules/subscription/template-renderers/render-singbox.js`
- `functions/modules/subscription/builtin-singbox-generator.js`
- `functions/modules/subscription/template-pipeline.js`
- `functions/modules/subscription/template-processor.js`
- `tests/unit/singbox-renderer-defects.test.js`
- `tests/unit/rule-generator-render-matrix.test.js`
- `tests/unit/builtin-singbox-generator.test.js`
- `docs/superpowers/specs/2026-09-05-pr-singbox-renderer-defects.md`
- `docs/superpowers/plans/2026-09-07-singbox-renderer-defects.md`

The pre-existing edit to `docs/superpowers/specs/2026-09-05-singbox-visual-rule-parity.md` is not part of this work and was preserved.
