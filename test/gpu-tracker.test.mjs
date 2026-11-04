import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, lowestAvailable, filterRows, historyPaths, historySeries, previousChange,
  centralTime, safeProductUrl, validateDocuments } from '../lib/gpu-tracker-data.mjs';

const now = Date.parse('2026-11-03T18:00:00Z');
const listing = { listing_id: 'mc-card', card_id: 'card', retailer_id: 'mc', condition: 'new', enabled: true };
const retailer = { retailer_id: 'mc', seller: 'Micro Center', name: 'Micro Center', location: 'Overland Park, KS', allowed_hostname: 'www.microcenter.com' };
const watchlist = { schema_version: '1.0', listings: [listing], retailers: [retailer] };
const observation = { observation_id: 'obs-1', offer_id: 'offer-1', listing_id: 'mc-card', card_id: 'card', retailer_id: 'mc',
  collection_status: 'success', seller: 'Micro Center', condition: 'new', location: 'Overland Park, KS', currency: 'USD',
  price_usd: 700, price_checked_at_utc: '2026-11-03T17:00:00Z', availability: 'in_stock' };
const latest = value => ({ schema_version: '1.0', listings: [{ listing_id: 'mc-card', last_attempt_status: 'success', last_successful_observation: value }] });

test('uncollected listings have no price and do not count as in-stock', () => {
  const rows = buildRows(watchlist, { listings: [] }, 'card', now);
  assert.equal(rows.length, 1); assert.equal(rows[0].observation, null);
  assert.equal(lowestAvailable(rows), null); assert.equal(filterRows(rows, 'all', true).length, 0);
});
test('current successful price is eligible', () => {
  const rows = buildRows(watchlist, latest(observation), 'card', now);
  assert.equal(lowestAvailable(rows), 700); assert.equal(rows[0].stale, false);
});
test('failed check retains the original successful price and timestamp, but is stale', () => {
  const input = latest(observation); input.listings[0].last_attempt_status = 'timeout';
  const row = buildRows(watchlist, input, 'card', now)[0];
  assert.equal(row.observation.price_usd, 700);
  assert.equal(row.observation.price_checked_at_utc, '2026-11-03T17:00:00Z');
  assert.equal(row.stale, true); assert.equal(row.eligible, false);
});
test('old and implausibly future prices are excluded from current comparisons', () => {
  for (const date of ['2026-11-01T17:00:00Z', '2026-11-05T17:00:00Z']) {
    const row = buildRows(watchlist, latest({ ...observation, price_checked_at_utc: date }), 'card', now)[0];
    assert.equal(row.stale, true); assert.equal(row.eligible, false);
  }
});
test('sold-out price remains visible but is not a lowest-available candidate', () => {
  const rows = buildRows(watchlist, latest({ ...observation, availability: 'out_of_stock' }), 'card', now);
  assert.equal(rows[0].observation.price_usd, 700); assert.equal(lowestAvailable(rows), null);
});
test('marketplace, incorrect models and incorrect locations are rejected', () => {
  for (const change of [{ seller: 'Marketplace' }, { card_id: 'other' }, { location: 'Elsewhere' }, { condition: 'used' }]) {
    assert.equal(buildRows(watchlist, latest({ ...observation, ...change }), 'card', now)[0].observation, null);
  }
});
test('null, zero, string and nonfinite prices are never displayed as real prices', () => {
  for (const price of [null, 0, -1, '700', Infinity, NaN]) {
    assert.equal(buildRows(watchlist, latest({ ...observation, price_usd: price }), 'card', now)[0].observation, null);
  }
});
test('history index filters and deduplicates safe paths by date range', () => {
  assert.deepEqual(historyPaths({ schema_version: '1.0', files: ['2026/11/2026-11-03.json', '2026/11/2026-11-03.json',
    '2026/10/2026-10-01.json', '../latest.json', '2026/11/2026-10-30.json', '2026/12/2026-12-01.json'] }, 7, now), ['2026/11/2026-11-03.json']);
});
test('history keeps only successful matching observations and deduplicates IDs', () => {
  const rows = buildRows(watchlist, latest(observation), 'card', now);
  const points = historySeries([null, observation, observation, { ...observation, seller: 'Other' },
    { ...observation, collection_status: 'timeout', price_usd: null }], rows, 7, now);
  assert.equal(points[0].points.length, 1);
});
test('previous price change never compares different offer identities or same-time observations', () => {
  const prior = { ...observation, observation_id: 'older', price_usd: 730, price_checked_at_utc: '2026-11-02T17:00:00Z' };
  assert.equal(previousChange(observation, [prior]), -30);
  assert.equal(previousChange(observation, [{ ...prior, offer_id: 'other' }, observation]), null);
});
test('Central Time formatting handles CST and CDT and missing timestamps', () => {
  assert.match(centralTime('2026-11-03T18:00:00Z').time, /12:00 PM CST/);
  assert.match(centralTime('2026-10-22T17:59:00Z').time, /12:59 PM CDT/);
  assert.equal(centralTime(null), null);
});
test('product links require HTTPS and the exact configured retailer hostname', () => {
  assert.equal(safeProductUrl('javascript:alert(1)', 'www.microcenter.com'), null);
  assert.equal(safeProductUrl('https://www.microcenter.com.evil.test/x', 'www.microcenter.com'), null);
  assert.equal(safeProductUrl('https://www.microcenter.com/product/123', 'www.microcenter.com'), 'https://www.microcenter.com/product/123');
});
test('initial document envelopes validate; duplicate and unknown references fail', () => {
  const cards = { schema_version: '1.0', cards: [{ card_id: 'card' }] };
  assert.doesNotThrow(() => validateDocuments(cards, watchlist, latest(observation)));
  assert.throws(() => validateDocuments(cards, { ...watchlist, listings: [listing, listing] }, latest(observation)));
  assert.throws(() => validateDocuments({ ...cards, cards: [{ card_id: 'other' }] }, watchlist, latest(observation)));
});
