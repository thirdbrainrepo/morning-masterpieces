# Exhibitions — curriculum architecture (agreed 2026-07-09)

The initial 50-work survey is the **soft opening** and becomes the
**permanent collection (PC)**. Works are never lost: exhibitions draw from
the whole catalog, PC works included.

## Model

- **Catalog**: every work ever prepared (seeds + variants + narration).
  Adding to the catalog never remaps anyone's day.
- **Exhibition**: a named, ordered selection of catalog work IDs with an
  intent statement, an opening date, and a run length. Daily index within
  an exhibition = days since ITS opening, mod ITS length — deterministic
  and stateless, same principle as today.
- **Permanent collection**: the default rotation, always running on its own
  clock (days since 2026-01-01 mod N, exactly today's behavior). It is the
  fallback daily whenever no exhibition is active — and the *always
  available* alternate daily when one is.

## Client behavior

- Default view while an exhibition runs: the exhibition's daily work.
- **PC toggle**: a user preference (localStorage — a preference, not
  content state) that swaps the daily to the permanent collection's clock.
  Serves the visitor who binges an exhibition's full narrative arc in one
  sitting and still wants a fresh image each morning.
- Optional light interaction: a "show me something from the permanent
  collection" one-off shuffle, distinct from the daily.
- Shortcut/wallpaper endpoints stay stable: `today/*` follows the default
  (exhibition) rotation; per-rotation stable URLs (e.g. `today/pc/*`) can
  serve toggled users' automations later.

## Museum tie-ins

Exhibitions may be timed to overlap real shows at Bay Area museums
(de Young, Legion of Honor, SFMOMA, Asian Art Museum, Cantor, BAMPFA).
The tie-in is **related public-domain works** — precursors, influences,
same-movement cousins from open-access collections — never reproductions
of the (typically copyrighted) works on the walls. Lessons point at the
show and encourage the visit. This is deliberately both the better
pedagogy and the legally clean position.

**Rights stance is unchanged and non-negotiable**: every image
machine-verified public domain via the source's own rights flag
(build.mjs enforces; validate.mjs gates deploys). Fair use is not relied
on anywhere — full-work public wallpapers are weak fair-use ground, and
the open-access museum world (Met, AIC, NGA, Rijksmuseum, Getty,
Smithsonian, Cleveland, Yale, Paris Musées…) makes it unnecessary.

## Research heartbeat

A monthly scheduled agent sweeps the six museums' exhibition calendars
and delivers a brief: current/upcoming shows, dates, themes, and rough
PD tie-in pitches. Curation stays human; the automation only watches.

## Constraints on the horizon

- ~8.5MB per work; GitHub Pages caps a published site at 1GB. Site is
  ~430MB at 50 works → roughly 60–70 more works before media must move
  to object storage + CDN. Plan the hosting move alongside the first
  large exhibition build.
- Narration renders are screened by scripts/check-narrations.mjs (~1 in
  10 raw takes is defective); pronunciation pins live in speakable().
