import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, lowestAvailable, filterRows, historyPaths, historySeries, previousChange,
  centralTime, safeProductUrl, validateDocuments, medianSeries, familyMedianSeries, gpuFamilies } from '../lib/gpu-tracker-data.mjs';

const now = Date.parse('2026-11-03T18:00:00Z');
const listing = { listing_id: 'mc-card', card_id: 'card', retailer_id: 'mc', condition: 'new', enabled: true };
const retailer = { retailer_id: 'mc', seller: 'Micro Center', name: 'Micro Center', location: 'Overland Park, KS', allowed_hostname: 'www.microcenter.com' };
const watchlist = { schema_version: '1.0', listings: [listing], retailers: [retailer] };
const observation = { observation_id: 'obs-1', offer_id: 'offer-1', listing_id: 'mc-card', card_id: 'card', retailer_id: 'mc',
  collection_status: 'success', seller: 'Micro Center', condition: 'new', location: 'Overland Park, KS', currency: 'USD',
  price_usd: 700, price_checked_at_utc: '2026-11-03T17:00:00Z', availability: 'in_stock' };
const latest = value => ({ schema_version: '1.0', listings: [{ listing_id: 'mc-card', last_attempt_status: 'success', last_successful_observation: value }] });

const medianCards = [{ card_id: 'card', gpu_model: 'Test GPU' }, { card_id: 'other', gpu_model: 'Other GPU' }];
const marketCards = [
  { card_id:'card', gpu_manufacturer:'NVIDIA', gpu_model:'RTX 5070 Ti', specs:{vram_gb:16,memory_type:'GDDR7'} },
  { card_id:'pny', gpu_manufacturer:'NVIDIA', gpu_model:'RTX 5070 Ti', specs:{vram_gb:16,memory_type:'GDDR7'} },
  { card_id:'small', gpu_manufacturer:'NVIDIA', gpu_model:'RTX 5070 Ti', specs:{vram_gb:8,memory_type:'GDDR7'} }
];
test('market grouping keeps VRAM variants separate and includes different manufacturers',()=>{
  const groups=gpuFamilies(marketCards);
  assert.equal(groups.length,2); assert.equal(groups[0].models.length,2);
});
test('family median includes multiple exact models at the same retailer without retailer weighting',()=>{
  const w={listings:[listing,{...listing,listing_id:'pny-mc',card_id:'pny'}],retailers:[retailer]};
  const first={...observation,run_id:'market',attempted_at_utc:observation.price_checked_at_utc,price_usd:1200};
  const second={...first,observation_id:'pny',listing_id:'pny-mc',card_id:'pny',offer_id:'pny-offer',price_usd:800};
  const p=familyMedianSeries([first,second,second],marketCards,w,7,now)[0].points[0];
  assert.equal(p.price_usd,1000);assert.equal(p.offer_count,2);assert.equal(p.model_count,2);assert.equal(p.retailer_count,1);
});
test('family median deduplicates equivalent listings and excludes a later failed same-offer check',()=>{
  const w={listings:[listing,{...listing,listing_id:'duplicate'}],retailers:[retailer]};
  const first={...observation,run_id:'market',attempted_at_utc:observation.price_checked_at_utc};
  const dup={...first,listing_id:'duplicate',observation_id:'duplicate'};
  assert.equal(familyMedianSeries([first,dup],marketCards,w,7,now)[0].points[0].offer_count,1);
  const fail={...dup,attempted_at_utc:'2026-11-03T17:10:00Z',collection_status:'timeout',price_checked_at_utc:null,price_usd:null};
  assert.equal(familyMedianSeries([first,fail],marketCards,w,7,now)[0].points[0].offer_count,0);
});
test('family history preserves original narrow coverage and breaks lines when added models contribute',()=>{
  const w={listings:[listing,{...listing,listing_id:'pny-mc',card_id:'pny'}],retailers:[retailer]};
  const first={...observation,run_id:'old',attempted_at_utc:observation.price_checked_at_utc,price_usd:1200};
  const second={...first,observation_id:'second',run_id:'expanded',attempted_at_utc:'2026-11-03T17:30:00Z',price_checked_at_utc:'2026-11-03T17:30:00Z'};
  const third={...second,observation_id:'pny',listing_id:'pny-mc',card_id:'pny',offer_id:'pny-offer',price_usd:800};
  const pts=familyMedianSeries([first,second,third],marketCards,w,7,now)[0].points;
  assert.deepEqual(pts.map(p=>p.model_count),[1,2]);assert.deepEqual(pts.map(p=>p.price_usd),[1200,1000]);
  assert.equal(pts[1].coverage_changed,true);assert.notEqual(pts[0].offer_id,pts[1].offer_id);
});
const medianWatchlist = { listings: [1, 2, 3, 4].map(n => ({ ...listing, listing_id: `listing-${n}`, retailer_id: `retailer-${n}` })),
  retailers: [1, 2, 3, 4].map(n => ({ ...retailer, retailer_id: `retailer-${n}`, seller: `Seller ${n}` })) };
function medianObservation(n, price, run = 'run-1', extra = {}) {
  return { ...observation, observation_id: `${run}-${n}`, run_id: run, listing_id: `listing-${n}`, retailer_id: `retailer-${n}`,
    seller: `Seller ${n}`, price_usd: price, attempted_at_utc: '2026-11-03T17:00:00Z', ...extra };
}
test('median uses odd/even calculations, range, and unique retailer count', () => {
  const values = [medianObservation(1, 100), medianObservation(2, 200), medianObservation(3, 900)];
  let point = medianSeries([...values, values[0]], medianCards, medianWatchlist, 7, now)[0].points[0];
  assert.equal(point.price_usd, 200); assert.equal(point.minimum_usd, 100); assert.equal(point.maximum_usd, 900); assert.equal(point.retailer_count, 3);
  point = medianSeries(values.slice(0, 2), medianCards, medianWatchlist, 7, now)[0].points[0];
  assert.equal(point.price_usd, 150); assert.equal(point.retailer_count, 2);
});
test('median excludes stock, seller, identity, and stale-price failures', () => {
  const values = [medianObservation(1, 100), medianObservation(2, 20, 'run-1', { availability: 'out_of_stock' }),
    medianObservation(3, 30, 'run-1', { seller: 'Marketplace' }), medianObservation(4, 40, 'run-1', { stale: true })];
  const point = medianSeries(values, medianCards, medianWatchlist, 7, now)[0].points[0];
  assert.equal(point.price_usd, 100); assert.equal(point.retailer_count, 1);
  assert.equal(medianSeries([medianObservation(1, 100, 'run-1', { card_id: 'other' })], medianCards, medianWatchlist, 7, now).length, 0);
  assert.equal(medianSeries([medianObservation(1, 100, 'run-1', { price_checked_at_utc: '2026-10-30T17:00:00Z' })], medianCards, medianWatchlist, 7, now)[0].points[0].retailer_count, 0);
});
test('missing eligible prices create gaps and separate line segments without carrying prices', () => {
  const values = [medianObservation(1, 100), medianObservation(2, null, 'run-2', { collection_status: 'parse_error', price_checked_at_utc: null, attempted_at_utc: '2026-11-03T17:20:00Z' }),
    medianObservation(1, 200, 'run-3', { attempted_at_utc: '2026-11-03T17:40:00Z', price_checked_at_utc: '2026-11-03T17:40:00Z' })];
  const points = medianSeries(values, medianCards, medianWatchlist, 7, now)[0].points;
  assert.deepEqual(points.map(p => p.price_usd), [100, null, 200]); assert.notEqual(points[0].offer_id, points[2].offer_id);
  assert.equal(points[1].retailer_count, 0);
});
test('a later failed retry in the same run removes that retailer from the median', () => {
  const values = [medianObservation(1, 100), medianObservation(1, null, 'run-1', { observation_id: 'retry', attempted_at_utc: '2026-11-03T17:10:00Z', collection_status: 'identity_mismatch', price_checked_at_utc: null }), medianObservation(2, 200)];
  const point = medianSeries(values, medianCards, medianWatchlist, 7, now)[0].points[0];
  assert.equal(point.price_usd, 200); assert.equal(point.retailer_count, 1);
});
test('median respects date window and skips future or unidentified runs', () => {
  assert.equal(medianSeries([medianObservation(1, 100, '')], medianCards, medianWatchlist, 7, now).length, 0);
  const values = [medianObservation(1, 100, 'old', { attempted_at_utc: '2026-10-01T17:00:00Z', price_checked_at_utc: '2026-10-01T17:00:00Z' }), medianObservation(2, 200, 'future', { attempted_at_utc: '2026-12-01T17:00:00Z', price_checked_at_utc: '2026-12-01T17:00:00Z' })];
  assert.equal(medianSeries(values, medianCards, medianWatchlist, 7, now).length, 0);
});

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

