# Morning Masterpieces — Code Review

**Review date:** July 3, 2026  
**Scope:** Repository architecture, source and rights validation, image and audio
pipelines, deterministic date logic, PWA behavior, service worker, deployment,
accessibility, documentation, and readiness for a larger collection.  
**Disposition:** Review only. No application code or generated asset was changed.

## Executive assessment

Morning Masterpieces is unusually coherent for a small, static project. Its
core product idea is reflected directly in the architecture: a deterministic
rotation, a deliberately simple PWA, prebuilt media, and no backend or user
state to operate. The image compositor is careful, the current generated
collection is internally complete, and both phone and wide layouts render
well.

The most important risks are in the build's safety boundaries rather than the
visible app:

1. `--verify-only` exits successfully even when every source fails.
2. A normal build writes a shortened manifest before reporting source failures.
3. The Commons path does not verify public-domain metadata or remote identity,
   and all 30 Commons seeds omit the required `expect` field.
4. The narration cache does not actually hash the voice file or the complete
   rendering configuration.
5. Deployment has no collection-wide integrity gate.

Those issues should be fixed before the next substantial collection wave. They
can silently weaken the exact invariants the project treats as architectural:
copyright enforcement, stable rotation length, source identity, and consistent
voice.

The current media footprint also makes a future hosting decision unavoidable:
the published `site/` directory is already about **341 MB for 50 works**.
GitHub Pages currently caps a published site at 1 GB, so roughly linear growth
would reach that ceiling near 150 works. Git history will grow faster whenever
derived binaries are replaced.

## Priority definitions

- **P1 — needed fix:** Can violate a stated invariant, produce a false-success
  build, or publish a structurally damaged collection.
- **P2 — important:** User-visible correctness, resilience, accessibility, or
  maintainability issue that should be scheduled soon.
- **P3 — improvement:** Lower-risk cleanup, documentation, or future-proofing.

## Findings

### P1 — The verifier reports success when verification fails

**Where:** [`scripts/build.mjs` lines 228–238](scripts/build.mjs#L228-L238)

The script collects failures and prints them, then immediately returns in
`VERIFY_ONLY` mode. `process.exitCode = 1` is only set later, on the normal build
path.

A controlled review run replaced network responses with HTTP 404s. The command
reported `0/50 resolved, 50 FAILED` and still exited with status `0`. This makes
the documented preflight unsafe in shell scripts, CI, and manual workflows that
trust the exit status.

**Needed fix:** If `failed.length > 0`, set a nonzero exit code or throw before
the `VERIFY_ONLY` return. Add a regression test that stubs one failed resolver
and asserts a nonzero status.

### P1 — A failed build rewrites the rotation with only the successful works

**Where:** [`scripts/build.mjs` lines 228–271](scripts/build.mjs#L228-L271)

The normal build constructs `items` from `ok`, writes `site/artworks.json`, and
only then sets a failing exit code. A transient failure for one museum can
therefore turn the 50-item manifest into a 49-item manifest. Because the daily
index is modulo the manifest length, that changes every subsequent assignment
and can make a failed run look like a legitimate collection update in the
working tree.

The process is not transactional in two other places:

- Downloads stream directly to their final cache filename. An interrupted
  transfer can leave a partial file that future runs treat as immutable because
  only existence is checked
  ([`scripts/build.mjs` lines 149–156](scripts/build.mjs#L149-L156)).
- Derived variants are considered valid when all six paths merely exist;
  their dimensions, decodability, source inputs, and build configuration are
  not checked
  ([`scripts/build.mjs` lines 159–168](scripts/build.mjs#L159-L168)).

**Needed fix:** Resolve and validate every seed before mutating committed
outputs. Abort with the existing manifest untouched if any source fails. Write
downloads and manifests to temporary paths, validate them, then atomically
rename. Replace existence-only caching with an input/configuration hash.

### P1 — The Commons path does not enforce the documented rights and identity guarantees

**Where:** [`scripts/build.mjs` lines 126–140](scripts/build.mjs#L126-L140),
[`scripts/build.mjs` lines 192–200](scripts/build.mjs#L192-L200), and the
Commons entries in [`data/seeds/`](data/seeds)

Met and AIC records are checked against first-party public-domain flags. The
Commons resolver only sends a `HEAD` request to `Special:FilePath`; it then
copies `seed.file` and `seed.artist` back as the “fetched” identity and assigns
the hard-coded label `Public domain — via Wikimedia Commons`. It does not query
Commons file metadata, a rights statement, license URL, creator, source, or
copyright status.

Current collection evidence:

- 30 of 50 works use Commons.
- 0 of those 30 seeds has `expect`, despite the invariant that every seed must
  carry it.
- All 30 supply a museum `objectUrl`, so the generated manifest no longer
  retains a link to the exact Commons file page that supplied the bytes and
  rights metadata.
- The runbook says Commons works should be by artists dead 100+ years, but the
  Commons entry for Edvard Munch records `1863–1944`
  ([`data/seeds/04-impressionism-modern.mjs` lines 124–137](data/seeds/04-impressionism-modern.mjs#L124-L137)).
  This does **not** establish that *The Scream* is copyrighted; it establishes
  that the stated 100-year curation rule is neither true of every seed nor
  machine-enforced.

For Commons records, an `expect` check against values copied from the same seed
would be tautological. The remote metadata must be fetched first for the check
to mean anything.

**Needed fix:** Resolve Commons files through the MediaWiki API and enforce
explicit accepted rights values from `imageinfo.extmetadata` (for example,
copyrighted status and license short name/URL). Compare the remote title and
creator to a required seed expectation. Preserve separate `imageSourceUrl` and
`objectUrl` fields, plus license code, license URL, source institution, access
date, and any jurisdictional rationale. Fail closed when metadata is absent or
ambiguous.

### P1 — The narration hash does not hash the voice or the complete renderer

**Where:** [`scripts/narrate.mjs` lines 164–174](scripts/narrate.mjs#L164-L174)

The comment and runbook promise that changing `data/voice/hanna.wav` invalidates
every narration. The hash includes only `path.basename(REF_AUDIO)`, which is
always `hanna.wav`. Replacing the audio bytes at the same path leaves every
hash unchanged and causes all 50 files to be skipped.

The hash also omits other output-shaping inputs:

- `TTS_MODEL`
- sentence-merging and segmenting behavior
- normalization and AAC settings
- a renderer/schema version

Changing any of those can require a complete rerender without changing the
current hash.

**Needed fix:** Hash the actual reference-audio bytes, normalized spoken
segments, TTS model, pause configuration, encoding configuration, and an
explicit renderer version. Produce each `.m4a` at a temporary path, validate it
with `ffprobe`, and atomically replace the old file only after success.

### P1 — Deployment validates only today's five files, not the collection

**Where:** [`.github/workflows/deploy.yml` lines 27–39](.github/workflows/deploy.yml#L27-L39)

The deployment job runs only `scripts/today.mjs` before uploading the entire
site. That proves the current item's five image paths exist. It does not prove:

- all manifest items have all six image variants and an audio file;
- image dimensions and formats are correct;
- every narration hash has a corresponding valid file;
- slugs are unique and paths remain inside the intended directories;
- seed and manifest order/count match;
- required metadata and rights evidence are present;
- JavaScript and Python parse;
- the service worker shell paths exist.

A deleted or corrupt asset for any non-current work can therefore deploy
successfully and remain hidden until its day arrives.

**Needed fix:** Add a read-only `scripts/validate.mjs` and make it a required
step before `today.mjs` and Pages upload. It should validate schema, uniqueness,
rights fields, order, every asset, hashes, dimensions, and daily calculations
for representative dates. Keep source-network verification as a separate
explicit job because it has different reliability and privacy characteristics.

### P2 — “Today” has three different timezone/DST failure modes

**Where:** [`site/app.js` lines 12–32](site/app.js#L12-L32),
[`scripts/today.mjs` lines 17–25](scripts/today.mjs#L17-L25), and
[`.github/workflows/deploy.yml` lines 6–9](.github/workflows/deploy.yml#L6-L9)

1. The PWA uses the viewer's local calendar date. The workflow forces
   `America/Los_Angeles`. A user in another timezone can therefore see one work
   in the PWA while the stable `/today/*` wallpaper endpoints still serve
   another. For example, at 1:00 AM in New York it is still the previous day in
   Los Angeles.
2. The cron is fixed at `08:10 UTC`. That is 12:10 AM Pacific only during
   standard time; during daylight time it is 1:10 AM. The stable endpoint is
   stale for roughly 70 minutes after local midnight for about half the year.
3. Previous/next navigation adds or subtracts exactly 86,400,000 milliseconds.
   Local calendar days are not always 24 hours. A reproduced case at 12:30 AM
   on November 1, 2026 makes “next” remain November 1; at 12:30 AM on March 9,
   2026, “previous” skips March 8 entirely.

**Needed fix:** Define one explicit product timezone or a deliberately global
date policy. Represent navigation as a calendar date, not a timestamp, and add
calendar days using UTC date components or `Temporal.PlainDate` when available.
Have both browser and Node paths call a shared, pure date/index implementation.
For the cron, either run frequently with a Pacific-midnight guard or use a
scheduler that understands the named timezone.

### P2 — The service worker can pin stale or failed media indefinitely

**Where:** [`site/sw.js` lines 37–67](site/sw.js#L37-L67)

Artwork and audio URLs are cache-first because the code assumes a slug's bytes
never change. The project explicitly supports `--force` recomposition and has
already changed presentation over time, so that assumption is not durable.
Installed PWAs can retain old image/audio bytes until `VERSION` is manually
bumped.

The service worker also caches responses without checking `res.ok`. A
temporarily missing narration can cache a 404 under its future stable URL.
Network-first shell requests can similarly replace a good cached response with
an error response. Finally, cache writes and trimming run as unawaited work
rather than being tied to the fetch event's lifetime.

Offline navigation is also exact-URL only. A first offline visit to
`/?view=full` will not fall back to the cached app shell unless that exact query
URL was previously cached.

**Needed fix:** Give immutable media content-versioned URLs, generated from the
build hash. Cache only successful responses. Await cache writes with
`event.waitUntil` or in the response promise. For navigation requests, fall
back to the cached `index.html`. Generate the cache version from the deployed
shell/manifest instead of relying on a hand-edited constant.

### P2 — Cache invalidation does not include caption metadata or compositor inputs

**Where:** [`scripts/build.mjs` lines 149–168](scripts/build.mjs#L149-L168)

Correcting a title, artist, or year updates `artworks.json` but does not update
the text stamped into existing wallpapers unless the operator remembers
`--force`. A compositor change has the same implicit manual dependency.
Original downloads are never refreshed even if the source URL or source record
changes.

**Needed fix:** Store per-work build metadata containing source content hash,
caption inputs, compositor version, variant settings, and tool versions. Rebuild
only the affected outputs when that fingerprint changes. Keep `--force` as an
override, not the normal correctness mechanism.

### P2 — The fullscreen viewer is visually good but not a modal for assistive technology

**Where:** [`site/index.html` lines 75–82](site/index.html#L75-L82) and
[`site/app.js` lines 242–258](site/app.js#L242-L258)

The lightbox has no dialog role, accessible label, or `aria-modal`. Opening it
does not move focus; closing it does not restore focus to the opener; the
background is not inert; and focus is not contained.

Runtime evidence confirmed that after opening the viewer, focus remained on
the underlying `View fullscreen` button and all background actions were still
exposed alongside the lightbox buttons. The image also has a click handler in
the page but is not itself keyboard-operable
([`site/index.html` lines 25–28](site/index.html#L25-L28)).

**Needed fix:** Use a `<dialog>` where supported, or implement equivalent
semantics: `role="dialog"`, `aria-modal="true"`, an accessible name, focus on
open, focus containment, background `inert`, and opener focus restoration.
Make the zoomable image a real button or rely solely on the existing fullscreen
button.

### P2 — The local build dependency check is incomplete and platform-specific

**Where:** [`scripts/build.mjs` lines 38–57](scripts/build.mjs#L38-L57) and
[`scripts/process_image.py` lines 20–52](scripts/process_image.py#L20-L52)

The compositor imports both Pillow and NumPy, but Python detection checks only
`import PIL`. It can select an interpreter that lacks NumPy even when a later
candidate has both. The README likewise documents Pillow but not NumPy.

Caption fonts are searched only in macOS system paths. On another platform the
silent fallback is Pillow's small default bitmap font, which would materially
change wallpaper output without failing the build.

**Needed fix:** Declare and pin Python dependencies, probe all required imports,
and vendor or explicitly require the chosen caption font. Record tool/font
versions in the build fingerprint. A small reproducible environment
(`requirements.txt` plus documented Python version, or a container) would make
future waves less machine-dependent.

### P2 — The build sends a personal email address to every source endpoint

**Where:** [`scripts/build.mjs` lines 31 and 59–68](scripts/build.mjs#L31-L68)

The user agent contains a hard-coded personal email address and is transmitted
to the Met, AIC, Wikimedia, and image hosts. A descriptive contact is good API
etiquette, but personal data should not be embedded in reusable public code or
sent without an explicit operator choice. This also prevented live source
verification during this review because external disclosure of that address
was not authorized.

**Needed fix:** Default to the public project URL as the contact and allow an
optional `SOURCE_CONTACT` environment variable for maintainers who deliberately
want to provide an email.

### P3 — Smaller reliability and maintenance issues

1. **Narration cleanup is not guaranteed.** Temporary audio is removed only on
   the successful path; errors leave the temp directory behind
   ([`scripts/narrate.mjs` lines 150–190](scripts/narrate.mjs#L150-L190)).
   Use `try/finally`.
2. **Final audio sample rate is surprising.** Inputs and silence are normalized
   to 44.1 kHz, but all current final AAC streams report 96 kHz because the
   final ffmpeg invocation does not pin the output rate. Explicitly choose and
   test the intended rate.
3. **Fetch response types are trusted.** Image downloads and wallpaper sharing
   do not verify MIME type or decodability before treating bytes as JPEG.
4. **Manifest validation is absent in the client.** A clear empty/malformed
   collection error would be better than downstream `undefined` failures.
5. **Documentation has drifted.**
   - `data/seeds.mjs` still says the survey ends with *American Gothic* (1930),
     while it ends with Kandinsky (1913).
   - The build header says the iPad output is 2388×2388; the compositor and
     actual files are 2420×2420.
   - The README says “3-action” Shortcut while the current recommended
     lock-and-home flow is four actions.
   - The runbook targets 120–160 lesson words; 15 of 50 lessons currently exceed
     160, with a maximum of 184. Either enforce the range or describe it as a
     guideline.

## What is already working well

- The 50-item seed and manifest orders match, and slugs are currently unique.
- All 300 expected image variants exist, decode successfully, and meet their
  intended fixed or maximum dimensions.
- All 50 audio files exist and probe as valid mono AAC; all 50 have hash
  entries and there are no orphan files or hashes.
- The locally materialized `today.json` matches the deterministic calculation for
  July 3, 2026: item 34, *Paris Street; Rainy Day*.
- JavaScript module syntax and Python source compilation pass.
- The image compositor makes high-quality choices that are easy to lose in a
  rewrite: uncropped art on lock wallpapers, explicit iPad safe geometry,
  float composition, deterministic dithering, and 4:4:4 high-quality JPEG.
- Met and AIC validation correctly fails closed on their first-party
  public-domain flags.
- The UI has no framework or third-party runtime dependency, uses safe
  `textContent` for editorial data, and keeps the daily experience fast.
- At-rest browser checks at 390×844 and 1280×800 showed clean responsive
  layouts, complete images, correct current work/date, functional next/today
  navigation, and the intended independent lesson scroll at wide widths.
- The global `[hidden]` rule and `/today/` service-worker exclusion preserve
  two subtle but important learned invariants.

## Verification performed

| Check | Result |
| --- | --- |
| Worktree inspection | Existing untracked `AGENTS.md` preserved; no source edits |
| JS syntax (`scripts`, `site`, and seed modules) | Pass |
| Python source compilation | Pass |
| Seed/manifest count and order | 50/50, pass |
| Required manifest fields | Pass |
| Required seed fields | Fail: `expect` missing on all 30 Commons seeds |
| Duplicate slugs | None |
| Image existence, decode, and dimensions | 300/300, pass |
| Audio existence, codec, duration, and hash coverage | 50/50, pass |
| Local PWA phone/wide/Shortcuts render | Pass, with modal accessibility issue |
| Navigation | Normal next/today pass; DST edge cases fail |
| Mocked all-source verifier failure | Reports 50 failures but exits 0 |
| Live museum/Commons verification | Not run; current command discloses a hard-coded personal email |

The repository currently has no automated test suite or validation command, so
the successful checks above are review-time diagnostics rather than repeatable
project guarantees.

## Expansion recommendations

### 1. Separate the catalog from rotations

The current array is simultaneously the catalog, chronology, and active
rotation. That is elegant at 50 works but becomes restrictive when there are
multiple courses, themes, regions, or seasonal selections.

A stronger model would have:

- `catalog/works/<slug>.json` or equivalent source records;
- stable work IDs independent of filename and display title;
- ordered rotation definitions containing IDs;
- a versioned rotation epoch with an effective start date;
- deterministic selection defined per rotation.

This prevents every catalog addition from unexpectedly remapping today's work.
The README currently calls a rotation-length jump harmless; with frequent waves
or external users, it becomes a breaking schedule change. Rotation epochs can
preserve old date assignments while allowing a new course to begin cleanly.

### 2. Add a real content schema and provenance ledger

Validate seeds before any network or file work. In addition to current fields,
consider:

- normalized creation start/end years alongside display text;
- creator authority ID and life dates;
- accession number, dimensions, department, and object type;
- geography/culture and subject tags;
- source record URL, exact image source URL, source ID, and fetch timestamp;
- rights code, rights URL, rights holder/source, jurisdiction, and verification
  method;
- editorial sources, reviewer, fact-check status, and last-reviewed date;
- visual description for screen readers;
- pronunciation or narration overrides for difficult names;
- content warnings or cultural-use notes where appropriate.

The official object page alone is not enough for a growing educational
collection. Readers and future editors should be able to trace both factual
claims and image rights.

### 3. Make builds content-addressed and reproducible

Treat each work as a small build graph:

`source bytes + metadata + compositor version + font + settings -> variants`

and:

`spoken segments + voice bytes + model + renderer version + settings -> audio`

Store those fingerprints in one generated build manifest. This gives reliable
incremental builds, immutable media URLs, service-worker cache busting, and a
clear answer to “why was this file rebuilt?”

Add golden-image tests for geometry and caption safe areas, plus inexpensive
numeric checks for dimensions, dither variance, and JPEG subsampling. Keep a
small representative fixture set—portrait, landscape, very wide, very tall,
short caption, and long caption—rather than rebuilding all works in routine CI.

### 4. Move large immutable media off the Pages source repo before ~150 works

Current approximate footprint:

- `site/images/`: 294 MB
- `site/audio/`: 43 MB
- complete published `site/`: 341 MB
- current loose Git object store: 465 MiB

GitHub's current documentation sets a 1 GB maximum for published Pages sites
and recommends keeping Pages source repositories at or below 1 GB:
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
GitHub also recommends object storage for generated files in large repositories:
[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits).

Before the collection triples, keep the shell, catalog, and daily endpoints on
Pages but move content-addressed images/audio to object storage plus a CDN, or
publish media through a dedicated immutable artifact pipeline. Git LFS is not a
transparent solution for the deployed site; GitHub documents that LFS cannot
be used to serve Pages assets directly:
[About Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage).

The wallpaper JPEGs should remain high quality. Savings should come from
architecture and web-specific variants, not by weakening the dithered
wallpaper invariant. The PWA display/zoom paths can independently adopt
responsive WebP/AVIF with JPEG fallback.

### 5. Add collection-wide CI and release reports

Every wave should produce a concise machine-generated report:

- works added/removed/reordered;
- dates whose assignments change;
- rights and identity verification results;
- rebuilt image/audio files and the fingerprint reason;
- asset count and byte growth;
- missing editorial review/citations;
- responsive and accessibility smoke results.

Run deterministic validation on every push. Run museum/Commons network
verification manually or on a less frequent schedule, with cached metadata and
clear retry semantics, so a transient museum outage does not mutate outputs.

### 6. Expand the learning experience, not just the item count

The strongest additions would make the collection feel like a course rather
than a larger carousel:

- **Multiple deterministic tracks:** chronological survey, women artists,
  printmaking, landscape, color, portraiture, or museum-specific tours.
- **Compare mode:** pair today's work with an earlier/later work and explain one
  concrete visual or historical connection.
- **Timeline and map:** place works in time and geography without changing the
  quiet daily landing page.
- **Technique glossary:** reusable short explanations for fresco, glazing,
  tenebrism, impasto, woodblock registration, and similar terms.
- **Editorial citations:** a small “Sources and further looking” section for
  each lesson.
- **Rich visual descriptions:** descriptions written for blind and low-vision
  visitors, separate from the title/artist alt text.
- **Searchable archive:** browse by artist, period, place, medium, museum,
  theme, and track once the catalog is too large to explore one arrow at a
  time.
- **Optional depth layers:** the current 120–180-word lesson remains the daily
  core, with expandable context for biography, technique, conservation, and
  reception.

### 7. Broaden scope deliberately

The current arc is predominantly a familiar Western canon with two Japanese
printmakers. A larger collection would be more valuable if it broadened
geography, culture, medium, and the definition of a “masterpiece,” rather than
only extending the same canon.

Potential directions include Chinese painting and calligraphy, South Asian
manuscript and court painting, Islamic arts, African works with ethically
appropriate image permissions and context, Indigenous works where digitization
and cultural-use policies permit inclusion, Latin American art, photography,
decorative arts, textiles, sculpture, and architecture.

Legal public-domain status should be treated as necessary but not always
sufficient. For culturally sensitive works, add source-community guidance,
display restrictions, sacred/ceremonial context, and museum cultural-rights
statements to the inclusion review.

## Suggested order of work

1. Fix verifier exit behavior and make manifest/download writes transactional.
2. Replace the Commons resolver with metadata-backed rights/identity checks and
   make `expect` mandatory in schema validation.
3. Correct the narration fingerprint and add atomic output validation.
4. Add `scripts/validate.mjs` and make it block deployment.
5. Define the canonical timezone/date policy and cover DST/timezone cases.
6. Repair service-worker cache versioning and lightbox accessibility.
7. Introduce catalog/rotation separation and content-addressed media before the
   next major scale increase.
8. Plan the hosting transition before the published site approaches 1 GB.

The project does not need a framework rewrite. Its best path is to preserve the
small static runtime and make the build, provenance, validation, and release
model as disciplined as the image compositor already is.
