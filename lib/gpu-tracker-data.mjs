// Shared browser/Node data rules. This module has no DOM or network dependencies.
export const DATA_BASE = 'https://raw.githubusercontent.com/RadDadd/gpu-price-tracker/main/';
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

export function hasPrice(observation) {
  return observation?.collection_status === 'success'
    && typeof observation.price_usd === 'number'
    && Number.isFinite(observation.price_usd) && observation.price_usd > 0
    && timestamp(observation.price_checked_at_utc) !== null;
}

export function matchesOffer(observation, listing, retailer) {
  return observation?.listing_id === listing.listing_id
    && observation.card_id === listing.card_id
    && observation.retailer_id === listing.retailer_id
    && observation.seller === retailer.seller
    && observation.condition === listing.condition
    && (observation.location ?? null) === (retailer.location ?? null)
    && observation.currency === 'USD';
}

export function buildRows(watchlist, latest, cardId, now = Date.now()) {
  const updates = new Map(latest.listings.map(row => [row.listing_id, row]));
  return watchlist.listings.filter(listing => listing.enabled && listing.card_id === cardId).map(listing => {
    const retailer = watchlist.retailers.find(item => item.retailer_id === listing.retailer_id);
    const update = updates.get(listing.listing_id);
    const candidate = update?.last_successful_observation;
    const observation = hasPrice(candidate) && matchesOffer(candidate, listing, retailer) ? candidate : null;
    const checked = timestamp(observation?.price_checked_at_utc);
    const failed = Boolean(update?.last_attempt_status && update.last_attempt_status !== 'success');
    const stale = Boolean(observation && (update.stale === true || failed || now - checked > STALE_AFTER_MS || checked > now + 300000));
    return { listing, retailer, observation, update, stale,
      eligible: Boolean(observation && !stale && observation.availability === 'in_stock') };
  });
}

export function lowestAvailable(rows) {
  const values = rows.filter(row => row.eligible).map(row => row.observation.price_usd);
  return values.length ? Math.min(...values) : null;
}

export function filterRows(rows, retailerId, inStockOnly) {
  return rows.filter(row => (retailerId === 'all' || row.retailer.retailer_id === retailerId)
    && (!inStockOnly || row.eligible));
}

export function historyPaths(index, days, now = Date.now()) {
  if (index.schema_version !== '1.0' || !Array.isArray(index.files)) throw new Error('Unsupported history index');
  const cutoff = now - days * 86400000;
  return [...new Set(index.files)].filter(path => {
    if (typeof path !== 'string' || !/^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.json$/.test(path)) return false;
    const date = path.slice(8, 18);
    if (path.slice(0, 7) !== date.slice(0, 7).replace('-', '/')) return false;
    const time = Date.parse(date + 'T00:00:00Z');
    return Number.isFinite(time) && time + 86400000 > cutoff && time <= now;
  }).sort();
}

export function historySeries(observations, rows, days, now = Date.now()) {
  return rows.map(row => {
    const seen = new Set();
    const points = observations.filter(item => {
      const time = timestamp(item?.price_checked_at_utc);
      if (!hasPrice(item) || !matchesOffer(item, row.listing, row.retailer)
        || time < now - days * 86400000 || time > now + 300000) return false;
      const key = item.observation_id || [item.offer_id, item.price_checked_at_utc, item.price_usd].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => timestamp(a.price_checked_at_utc) - timestamp(b.price_checked_at_utc));
    return { id: row.listing.listing_id, name: row.retailer.name, points };
  }).filter(series => series.points.length);
}

export function previousChange(observation, points) {
  if (!hasPrice(observation) || !observation.offer_id) return null;
  const prior = points.filter(item => hasPrice(item) && item.offer_id === observation.offer_id
    && timestamp(item.price_checked_at_utc) < timestamp(observation.price_checked_at_utc))
    .sort((a, b) => timestamp(b.price_checked_at_utc) - timestamp(a.price_checked_at_utc))[0];
  return prior ? Math.round((observation.price_usd - prior.price_usd) * 100) / 100 : null;
}

export function centralTime(value) {
  if (timestamp(value) === null) return null;
  const date = new Date(value);
  return {
    date: new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }).format(date),
    time: new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date)
  };
}

export function safeProductUrl(value, hostname) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === hostname ? url.href : null; }
  catch { return null; }
}

export function validateDocuments(cards, watchlist, latest) {
  if ([cards, watchlist, latest].some(doc => doc?.schema_version !== '1.0')
    || !Array.isArray(cards.cards) || !Array.isArray(watchlist.retailers)
    || !Array.isArray(watchlist.listings) || !Array.isArray(latest.listings)) throw new Error('Unsupported tracker data format');
  if (!cards.cards.length || new Set(cards.cards.map(card => card.card_id)).size !== cards.cards.length) throw new Error('Invalid card catalog');
  if (new Set(watchlist.listings.map(row => row.listing_id)).size !== watchlist.listings.length
    || new Set(watchlist.retailers.map(row => row.retailer_id)).size !== watchlist.retailers.length
    || new Set(latest.listings.map(row => row.listing_id)).size !== latest.listings.length) throw new Error('Duplicate tracker identifiers');
  for (const listing of watchlist.listings) {
    if (!cards.cards.some(card => card.card_id === listing.card_id)
      || !watchlist.retailers.some(retailer => retailer.retailer_id === listing.retailer_id)) throw new Error('Unmatched tracker listing');
  }
}
