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

// Each point uses only checks made for that exact card in the same run.
// Never carry a previous price into another run's median.
export function medianSeries(observations, cards, watchlist, days, now = Date.now()) {
  const listings = new Map(watchlist.listings.filter(l => l.enabled).map(l => [l.listing_id, l]));
  const retailers = new Map(watchlist.retailers.map(r => [r.retailer_id, r]));
  const runs = new Map();
  for (const obs of observations) {
    const listing = listings.get(obs?.listing_id), retailer = retailers.get(listing?.retailer_id);
    const attempted = timestamp(obs?.attempted_at_utc) ?? timestamp(obs?.price_checked_at_utc);
    if (!listing || !retailer || !matchesOffer(obs, listing, retailer) || !obs.run_id
      || attempted === null || attempted > now + 300000) continue;
    const key = JSON.stringify([obs.card_id, obs.run_id]);
    if (!runs.has(key)) runs.set(key, { cardId: obs.card_id, runId: obs.run_id, time: attempted, checks: new Map() });
    const run = runs.get(key);
    const checked = timestamp(obs.price_checked_at_utc);
    run.time = Math.max(run.time, attempted, checked !== null && checked <= now + 300000 ? checked : attempted);
    const previous = run.checks.get(obs.retailer_id);
    const previousAttempt = previous ? timestamp(previous.attempted_at_utc) ?? timestamp(previous.price_checked_at_utc) : -Infinity;
    if (!previous || attempted >= previousAttempt) run.checks.set(obs.retailer_id, obs);
  }
  return cards.map(card => {
    let segment = 0;
    const points = [...runs.values()].filter(run => run.cardId === card.card_id
      && run.time >= now - days * 86400000).sort((a, b) => a.time - b.time).map(run => {
      const prices = [...run.checks.values()].filter(obs => {
        const checked = timestamp(obs.price_checked_at_utc);
        return hasPrice(obs) && obs.availability === 'in_stock' && obs.stale !== true
          && checked <= run.time + 300000 && run.time - checked <= STALE_AFTER_MS;
      }).map(obs => obs.price_usd).sort((a, b) => a - b);
      const count = prices.length, middle = Math.floor(count / 2);
      const price = count ? count % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2 : null;
      if (!count) segment++;
      return { run_id: run.runId, price_checked_at_utc: new Date(run.time).toISOString(),
        price_usd: price, minimum_usd: count ? prices[0] : null, maximum_usd: count ? prices[count - 1] : null,
        retailer_count: count, availability: count ? 'in_stock' : 'unknown',
        offer_id: count ? `${card.card_id}:median:${segment}` : null };
    });
    return { id: card.card_id, name: card.gpu_model, points };
  }).filter(series => series.points.length);
}

// Family comparisons include every configured exact model with the same GPU and VRAM.
export function gpuFamilies(cards) {
  const groups = new Map();
  for (const card of cards) {
    const key = JSON.stringify([card.gpu_manufacturer, card.gpu_model, card.specs?.vram_gb, card.specs?.memory_type]);
    if (!groups.has(key)) groups.set(key, { ...card, card_id: key, name: `${card.gpu_model} · ${card.specs?.vram_gb ?? '?'} GB`, models: [] });
    groups.get(key).models.push(card);
  }
  return [...groups.values()];
}

export function familyMedianSeries(observations, cards, watchlist, days, now = Date.now()) {
  const families = gpuFamilies(cards);
  const familyByCard = new Map(families.flatMap(f => f.models.map(c => [c.card_id, f.card_id])));
  const listings = new Map(watchlist.listings.filter(l => l.enabled).map(l => [l.listing_id, l]));
  const retailers = new Map(watchlist.retailers.map(r => [r.retailer_id, r]));
  const runs = new Map();
  for (const obs of observations) {
    const listing = listings.get(obs?.listing_id), retailer = retailers.get(listing?.retailer_id);
    const familyId = familyByCard.get(obs?.card_id);
    const attempted = timestamp(obs?.attempted_at_utc) ?? timestamp(obs?.price_checked_at_utc);
    if (!familyId || !listing || !retailer || !matchesOffer(obs, listing, retailer) || !obs.run_id
      || attempted === null || attempted > now + 300000) continue;
    const key = JSON.stringify([familyId, obs.run_id]);
    if (!runs.has(key)) runs.set(key, { familyId, runId: obs.run_id, time: attempted, checks: new Map() });
    const run = runs.get(key), checked = timestamp(obs.price_checked_at_utc);
    run.time = Math.max(run.time, attempted, checked !== null && checked <= now + 300000 ? checked : attempted);
    // One observation per exact card + retailer + seller + condition + location.
    // Different models at the same retailer are distinct offers, not duplicates.
    const offerKey = JSON.stringify([obs.card_id, obs.retailer_id, obs.seller, obs.condition, obs.location ?? null]);
    const prior = run.checks.get(offerKey);
    const priorTime = prior ? timestamp(prior.attempted_at_utc) ?? timestamp(prior.price_checked_at_utc) : -Infinity;
    if (!prior || attempted > priorTime || (attempted === priorTime && (obs.observation_id ?? '') > (prior.observation_id ?? ''))) run.checks.set(offerKey, obs);
  }
  return families.map(family => {
    let segment = 0, priorModels = null;
    const points = [...runs.values()].filter(r => r.familyId === family.card_id && r.time >= now - days * 86400000)
      .sort((a,b) => a.time-b.time).map(run => {
        const checks = [...run.checks.values()];
        const eligible = checks.filter(obs => {
          const checked = timestamp(obs.price_checked_at_utc);
          return hasPrice(obs) && obs.availability === 'in_stock' && obs.stale !== true
            && checked <= run.time + 300000 && run.time - checked <= STALE_AFTER_MS;
        });
        const prices = eligible.map(o => o.price_usd).sort((a,b) => a-b), count = prices.length, middle = Math.floor(count/2);
        const models = [...new Set(eligible.map(o => o.card_id))].sort();
        const modelKey = JSON.stringify(models), coverageChanged = priorModels !== null && priorModels !== modelKey;
        if (!count || coverageChanged) segment++;
        priorModels = modelKey;
        return { run_id: run.runId, price_checked_at_utc: new Date(run.time).toISOString(),
          price_usd: count ? count % 2 ? prices[middle] : (prices[middle-1]+prices[middle])/2 : null,
          minimum_usd: count ? prices[0] : null, maximum_usd: count ? prices[count-1] : null,
          offer_count: count, retailer_count: new Set(eligible.map(o => o.retailer_id)).size,
          model_count: models.length, checked_model_count: new Set(checks.map(o => o.card_id)).size,
          configured_model_count: family.models.length, model_ids: models, coverage_changed: coverageChanged,
          availability: count ? 'in_stock' : 'unknown', offer_id: count ? `${family.card_id}:market:${segment}` : null };
      });
    return { id: family.card_id, name: family.name, points };
  }).filter(s => s.points.length);
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

