# GPU tracker data integration

## Deployment

The frontend is buildless: `gpu-tracker.html`, `gpu-tracker.css`, `gpu-tracker.js`, and `lib/gpu-tracker-data.mjs` live in `RadDadd/mywebsite`. The homepage links to the page with a relative URL, so it works on raddata.dev and under a GitHub Pages subpath. It does not alter `main.css`, the NFL pages, or chat endpoints.

Data comes directly from public raw files in `RadDadd/gpu-price-tracker/main`. Browser requests omit credentials, use a 15-second timeout, and ask caches to revalidate. Refreshing the page or pressing Refresh data reloads published JSON; it does not trigger collection. No personal or secret data belongs in these public files.

## Catalog and watchlist

`data/cards.json` contains `{ "schema_version": "1.0", "cards": [...] }`. The page reads `card_id`, `gpu_model`, `card_manufacturer`, `series`, `full_card_name`, `manufacturer_part_number`, `specs`, and `specs_status`. Specifications use `vram_gb`, `memory_type`, and `memory_bus_bits`, optionally `core_count`, `core_type`, `boost_clock_mhz`, and `recommended_psu_w`.

`config/watchlist.json` contains version 1.0, a `retailers` array, a `listings` array, and `collection_enabled`. Each retailer supplies `retailer_id`, `name`, `seller`, `location` (or null), and `allowed_hostname`. Each listing supplies `listing_id`, `card_id`, `retailer_id`, `condition`, `enabled`, and `product_url`.

Only configured HTTPS retailer domains are allowed for outbound product links. Card, listing, and retailer identifiers must be unique and references must match.

## Latest view

`data/latest.json` has this envelope:

```json
{
  "schema_version": "1.0",
  "generated_at_utc": null,
  "status": "not_collected",
  "listings": []
}
```

Once collected, a listing entry contains `listing_id`, `last_attempt_at_utc`, `last_attempt_status`, `stale` (optional boolean), and `last_successful_observation` (an observation object or null). A successful observation must match the configured listing/card/retailer, seller, condition, location and USD currency, have `collection_status: "success"`, a positive numeric `price_usd`, and a valid `price_checked_at_utc`.

The observation fields are documented in the data repo's `docs/data-model.md`. Rendered price metadata includes `availability`, `shipping_usd`, `shipping_status`, and `fulfillment`. Timestamp strings must be ISO 8601 UTC with a Z suffix.

The **Price checked** column always shows the last successful observation's timestamp in America/Chicago, including the correct CST/CDT abbreviation. It never shows file generation or a failed attempt as a successful price check. A failed attempt, explicit stale flag, or price older than 36 hours marks a retained price stale. Stale and out-of-stock prices cannot win lowest available or appear in the in-stock-only filter. Unknown shipping remains unknown.

## History index and dated snapshots

`data/history/index.json`:

```json
{
  "schema_version": "1.0",
  "generated_at_utc": null,
  "files": []
}
```

`files` contains history-relative paths such as `2026/11/2026-11-04.json`. Only this exact year/month/date format is accepted. Add a path only after its snapshot is written; deduplicate entries. Update snapshots, index, latest and summary together in one data commit. Never list the index itself or example files.

Each dated file is `{ "schema_version": "1.0", "date_utc": "2026-11-04", "observations": [...] }`, using the same observation fields. The page filters by timestamps, rejects unsuccessful or mismatched offers, deduplicates observation IDs, and groups chart lines by `offer_id`. Separate offer identities are never joined. A single observation is rendered as a dot, not an invented trend. Unavailable observations are hollow dots. Keyboard users can read the expandable values table; pointer/touch users can inspect nearby dots.

The page computes previous-check changes within the loaded history window, comparing strictly earlier observations of the same `offer_id`. Missing baselines show a dash. It currently does not depend on `data/summary.json` or claim lifetime lows; those producer metrics can be integrated later.

Failed history loads are reported without replacing the latest price table. Missing snapshots are not zero prices. The example-chart mode is opt-in, labelled illustrative, and isolated from all price comparisons.

## Verification

`node --test test/gpu-tracker.test.mjs` covers empty files, retained prices after failed checks, 36-hour staleness, seller/model identity, exact-offer changes, null/zero prices, date-window selection, invalid history paths, UTC-to-Central formatting, and outbound URL validation.

## All-card median chart

The market-view chart aggregates successful, positive USD prices by exact card and collection run. It includes only enabled listings with matching model, retailer, seller, condition, and location, and verified in-stock availability. One latest check per retailer is counted; a later failed retry removes that retailer for that run. Explicitly stale observations and prices more than 36 hours older than the run are excluded. Prices are never carried forward between runs. Cards not checked in a run gain no invented point.

For odd retailer counts, the median is the middle sorted price; for even counts, it is the arithmetic mean of the two middle prices. Tooltips and the accessible values table show the median, minimum, maximum, retailer count, and Central Time timestamp. One retailer is labeled explicitly. A checked card with no qualifying prices receives an unavailable point and breaks its line. New models show a dot until a second observation exists. Changes can reflect changes in retailer availability as well as item prices; tax and unverified shipping are excluded.

The chart has independent 7/30/90-day controls and model visibility toggles. It ignores the retailer and in-stock filters for the selected-card table. History loads cover the longer of the two chart windows. Illustrative example data is never used in median calculations.
