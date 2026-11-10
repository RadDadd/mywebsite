import {
  DATA_BASE, buildRows, filterRows, lowestAvailable, historyPaths, historySeries,
  previousChange, centralTime, safeProductUrl, validateDocuments, timestamp, familyMedianSeries, gpuFamilies
} from './lib/gpu-tracker-data.mjs?v=20261106-market';

const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const colors = ['#75b5ff', '#c3a1ff', '#79ddba', '#f0cb8b'];
const modelColors = ['#75b5ff', '#c3a1ff', '#79ddba', '#f0cb8b', '#ff9bb2', '#66d2e8', '#d7dc72'];
const state = { cards: [], watchlist: null, latest: null, selectedCard: null, selectedListing: null,
  days: 30, medianDays: 30, medianHidden: new Set(), history: [], historyError: '', historyLoading: false, demo: false, hiddenSeries: new Set() };
let loadVersion = 0;
let historyVersion = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svgElement(tag, attrs, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

async function fetchJson(path) {
  // GitHub's raw data CDN can retain old JSON for five minutes after an update.
  const url = new URL(DATA_BASE + path);
  url.searchParams.set('refresh', String(Date.now()));
  const response = await fetch(url.href, {
    mode: 'cors', credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Data request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 2000000) throw new Error('Data file exceeds the supported size');
  return JSON.parse(text);
}

function families() { return gpuFamilies(state.cards); }
function currentCard() { return families().find(card => card.card_id === state.selectedCard); }
function allRows() { return state.watchlist ? currentCard().models.flatMap(card => buildRows(state.watchlist, state.latest, card.card_id)) : []; }
function shownRows() { return filterRows(allRows(), $('retailer-filter').value, $('stock-filter').checked); }
function colorFor(id) {
  // Stable, distinct colors for individual listings rather than just four retailer colors.
  const index = Math.max(0, state.watchlist.listings.findIndex(listing => listing.listing_id === id));
  return `hsl(${(index * 137.508 + 205) % 360} 78% 69%)`;
}

function renderPicker() {
  const brandOrder = { NVIDIA: 0, AMD: 1 };
  const cards = families().sort((a, b) =>
    (brandOrder[a.gpu_manufacturer] ?? 2) - (brandOrder[b.gpu_manufacturer] ?? 2)
    || a.gpu_model.localeCompare(b.gpu_model, 'en', { numeric: true }));
  $('card-picker').replaceChildren(...cards.map(card => {
    const button = element('button', undefined, 'gpu-choice');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(card.card_id === state.selectedCard));
    button.append(element('strong', card.gpu_model), element('small', `${card.specs?.vram_gb ?? '—'} GB ${card.specs?.memory_type ?? ''} · ${card.models.length} models · ${[...new Set(card.models.map(c => c.card_manufacturer))].join(', ')}`));
    button.addEventListener('click', () => {
      state.selectedCard = card.card_id; state.selectedListing = null; state.hiddenSeries.clear();
      renderPicker(); renderTable(); renderSpecs(); renderChart();
    });
    return button;
  }));
}

function renderSpecs() {
  const card = currentCard();
  if (!card) return;
  const specs = card.specs ?? {};
  const labels = [card.name, `${card.models.length} tracked models`, ...card.models.map(c => `${c.card_manufacturer} ${c.series} · ${c.manufacturer_part_number}`)];
  if (specs.vram_gb) labels.push(`${specs.vram_gb} GB ${specs.memory_type ?? ''}`);
  if (specs.memory_bus_bits) labels.push(`${specs.memory_bus_bits}-bit`);
  if (specs.core_count) labels.push(`${specs.core_count.toLocaleString()} ${specs.core_type ?? 'cores'}`);
  $('card-specs').replaceChildren(...labels.filter(Boolean).map(text => element('span', text, 'spec')));
  $('specs-note').textContent = 'Core and memory specs apply to this GPU family. Cooling, clocks, dimensions, and PSU recommendations vary by exact model; follow its retailer link for details. New models may use retailer-verified specifications.';
}

function timeCell(value) {
  const cell = element('td', undefined, 'time-cell');
  const formatted = centralTime(value);
  if (!formatted) { cell.append(element('span', 'Not checked yet', 'pending')); return cell; }
  const date = element('time', formatted.date);
  date.dateTime = value;
  cell.append(date, element('small', formatted.time));
  return cell;
}

function renderTable() {
  const rows = shownRows().sort((a,b) => Number(b.eligible)-Number(a.eligible)
    || (a.observation?.price_usd ?? Infinity)-(b.observation?.price_usd ?? Infinity));
  const lowest = lowestAvailable(allRows());
  const specs = currentCard().specs ?? {};
  const basicStats = [
    specs.vram_gb ? `${specs.vram_gb} GB ${specs.memory_type ?? ''} VRAM`.replace(/ +/g, ' ') : null,
    specs.core_count ? `${specs.core_count.toLocaleString('en-US')} ${specs.core_type ?? 'cores'}` : null
  ].filter(Boolean).join(' · ');
  $('price-rows').replaceChildren(...rows.map(row => {
    const { observation: obs, listing, retailer, update, stale } = row;
    const tr = element('tr', undefined, state.selectedListing === listing.listing_id ? 'row-selected' : '');
    const name = element('td');
    const exactCard = state.cards.find(card => card.card_id === listing.card_id);
    name.append(element('span', retailer.name, 'retailer-name'), element('small', exactCard.full_card_name));
    if (basicStats) name.append(element('small', basicStats));
    if (retailer.location) name.append(element('small', retailer.location));
    const price = element('td');
    price.append(element('span', obs ? money(obs.price_usd) : '—', 'price'));
    if (row.eligible && obs.price_usd === lowest) price.append(element('span', 'Lowest available', 'best'));
    if (obs) {
      const shipping = obs.shipping_status === 'pickup_only' || obs.fulfillment === 'pickup' ? 'Local pickup'
        : typeof obs.shipping_usd === 'number' && Number.isFinite(obs.shipping_usd) && obs.shipping_usd >= 0
          ? (obs.shipping_usd === 0 ? 'Free shipping' : `+ ${money(obs.shipping_usd)} shipping`) : 'Shipping not verified';
      price.append(element('small', shipping));
    }
    const change = element('td');
    const delta = obs ? previousChange(obs, state.history) : null;
    change.append(element('span', delta === null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${money(Math.abs(delta))}`,
      delta < 0 ? 'price-drop' : delta > 0 ? 'price-rise' : ''));
    if (delta === null) change.append(element('small', 'No prior comparison'));
    const availability = element('td');
    const status = obs?.availability;
    const label = status === 'in_stock' ? 'In stock' : status === 'out_of_stock' ? 'Sold out' : status === 'preorder' ? 'Preorder' : 'Unknown';
    const badge = obs ? stale ? `Stale · ${label.toLowerCase()}` : label : update ? 'Check unsuccessful' : 'Awaiting first check';
    availability.append(element('span', badge, stale ? 'stale' : row.eligible ? 'in-stock' : status === 'preorder' ? 'preorder' : 'pending'));
    if (update?.last_attempt_status && update.last_attempt_status !== 'success') availability.append(element('small', 'Latest check failed'));
    const checked = timeCell(obs?.price_checked_at_utc);
    if (stale) checked.append(element('small', 'Last successful check; not current', 'stale'));
    const actionsCell = element('td');
    const actions = element('div', undefined, 'row-actions');
    const history = element('button', 'History'); history.type = 'button';
    history.setAttribute('aria-label', `Show ${exactCard.card_manufacturer} ${exactCard.series} at ${retailer.name} history`);
    history.setAttribute('aria-pressed', String(state.selectedListing === listing.listing_id));
    history.addEventListener('click', () => {
      state.demo = false; state.selectedListing = state.selectedListing === listing.listing_id ? null : listing.listing_id;
      state.hiddenSeries.clear(); renderTable(); renderChart();
      $('history-title').scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
    actions.append(history);
    const url = safeProductUrl(listing.product_url, retailer.allowed_hostname);
    if (url) { const link = element('a', 'View ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', `View card at ${retailer.name}`); actions.append(link); }
    actionsCell.append(actions); tr.append(name, price, change, availability, checked, actionsCell);
    return tr;
  }));
  $('table-empty').hidden = rows.length > 0;
  const eligible = allRows().filter(row => row.eligible);
  $('offer-count').textContent = `${rows.length} shown · ${currentCard().models.length} tracked models · ${eligible.length} fresh in-stock offers from ${new Set(eligible.map(r => r.retailer.retailer_id)).size} retailers`;
  $('comparison').setAttribute('aria-busy', 'false');
}

function renderStatus() {
  const generated = centralTime(state.latest.generated_at_utc);
  $('data-status').textContent = generated ? `Data file generated ${generated.date}, ${generated.time} · per-offer price-check times below`
    : 'Watchlist connected · no price observations collected yet';
  const notice = $('collection-notice');
  notice.hidden = state.watchlist.collection_enabled !== false;
  notice.textContent = state.latest.listings.some(listing => listing.last_successful_observation?.collection_status === 'success')
    ? 'One-time price snapshot · automatic collection is not enabled. Each offer shows its last successful price-check time.'
    : 'Price collection has not been enabled yet. The cards and retailers are ready; prices and timestamps will appear after successful checks.';
}

async function loadData() {
  const version = ++loadVersion; ++historyVersion;
  $('refresh').disabled = true; $('load-error').hidden = true;
  try {
    const [cards, watchlist, latest] = await Promise.all([
      fetchJson('data/cards.json'), fetchJson('config/watchlist.json'), fetchJson('data/latest.json')
    ]);
    if (version !== loadVersion) return;
    validateDocuments(cards, watchlist, latest);
    state.cards = cards.cards; state.watchlist = watchlist; state.latest = latest;
    state.history = []; state.historyError = ''; state.hiddenSeries.clear();
    if (!families().some(card => card.card_id === state.selectedCard)) state.selectedCard = families()[0].card_id;
    const previous = $('retailer-filter').value;
    const all = element('option', 'All retailers'); all.value = 'all';
    $('retailer-filter').replaceChildren(all, ...watchlist.retailers.map(retailer => {
      const option = element('option', retailer.name); option.value = retailer.retailer_id; return option;
    }));
    $('retailer-filter').value = watchlist.retailers.some(retailer => retailer.retailer_id === previous) ? previous : 'all';
    renderPicker(); renderStatus(); renderTable(); renderSpecs(); renderChart();
    await loadHistory();
  } catch (error) {
    if (version !== loadVersion) return;
    $('load-error').textContent = state.watchlist
      ? 'Could not refresh the tracker. Previously loaded data is still shown with its original timestamps. Try Refresh data again.'
      : 'Could not load the price data. Check your connection and try Refresh data again.';
    $('load-error').hidden = false;
    if (!state.watchlist) $('data-status').textContent = 'Tracker data unavailable';
    else renderTable();
    $('comparison').setAttribute('aria-busy', 'false');
  } finally {
    if (version === loadVersion) $('refresh').disabled = false;
  }
}

async function loadHistory() {
  const version = ++historyVersion;
  state.historyLoading = true; state.historyError = ''; renderChart();
  try {
    const index = await fetchJson('data/history/index.json');
    const paths = historyPaths(index, Math.max(state.days, state.medianDays));
    const observations = []; let failures = 0; let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (next < paths.length && version === historyVersion) {
        const path = paths[next++];
        try {
          const snapshot = await fetchJson('data/history/' + path);
          if (snapshot.schema_version !== '1.0' || !Array.isArray(snapshot.observations)) throw new Error('Invalid history file');
          observations.push(...snapshot.observations);
        } catch { failures++; }
      }
    }));
    if (version !== historyVersion) return;
    state.history = observations;
    if (failures) state.historyError = `${failures} history file${failures === 1 ? '' : 's'} could not be loaded; the chart may be incomplete.`;
  } catch {
    if (version !== historyVersion) return;
    state.history = [];
    state.historyError = 'Historical data is unavailable. The retailer table remains available; try Refresh data again.';
  } finally {
    if (version === historyVersion) { state.historyLoading = false; renderTable(); renderChart(); }
  }
}

function sampleSeries(rows) {
  // Explicitly opt-in illustrative data. Never enters the retailer table or stored history.
  return rows.map((row, j) => ({ id: row.listing.listing_id, name: row.retailer.name,
    points: [90, 70, 80, 45, 55, 20, 0].map((offset, i) => ({
      price_usd: 690 + j * 45 + offset,
      price_checked_at_utc: new Date(Date.UTC(2026, 0, 1) + i * (state.days - 1) / 6 * 86400000).toISOString(),
      availability: 'in_stock', offer_id: `example-${j}`
    })) }));
}

function renderChart() {
  if (!state.watchlist) return;
  const card = currentCard();
  let rows = shownRows();
  if (state.selectedListing) rows = rows.filter(row => row.listing.listing_id === state.selectedListing);
  // Historical series use every listing in the selected GPU family, regardless of table filters.
  const historyRows = allRows();
  const observations = [...state.history, ...historyRows.map(row => row.observation).filter(Boolean)];
  const series = state.demo ? sampleSeries(rows) : historySeries(observations, historyRows, state.days).map(item => {
    const listing = state.watchlist.listings.find(l => l.listing_id === item.id);
    const exact = state.cards.find(c => c.card_id === listing.card_id);
    return { ...item, name: `${exact.card_manufacturer} ${exact.series} · ${item.name}` };
  });
  const shown = series.filter(item => !state.hiddenSeries.has(item.id));
  const demo = $('demo-toggle'); demo.textContent = state.demo ? 'Return to collected history' : 'Preview example chart';
  demo.setAttribute('aria-pressed', String(state.demo));
  $('history-title').textContent = `${state.demo ? 'Example history' : 'Price history'} · ${card.gpu_model}`;
  $('history-description').textContent = state.demo ? 'Illustration only · invented prices, not retailer observations.' : 'Successful price observations · Central Time';
  $('chart-legend').replaceChildren(...series.map(item => {
    const button = element('button', undefined, 'legend-button'); button.type = 'button';
    button.setAttribute('aria-pressed', String(!state.hiddenSeries.has(item.id)));
    const swatch = element('span', undefined, 'legend-swatch'); swatch.style.backgroundColor = colorFor(item.id); swatch.setAttribute('aria-hidden', 'true');
    button.append(swatch, document.createTextNode(item.name));
    button.addEventListener('click', () => { if (state.hiddenSeries.has(item.id)) state.hiddenSeries.delete(item.id); else state.hiddenSeries.add(item.id); renderChart(); });
    return button;
  }));
  $('history-message').hidden = shown.length > 0;
  $('history-message').textContent = state.historyLoading && !state.demo ? 'Loading price history…'
    : series.length && !shown.length ? 'Select a retailer above to show its history.'
      : state.historyError || 'History will appear after the first successful price checks.';
  $('chart-note').textContent = state.demo ? 'Sample data for previewing the design. The table above continues to show only collected data.'
    : shown.length ? [state.historyError, 'History includes all tracked retailers regardless of the table filters. Dots are successful observations; hollow dots indicate unavailable or unknown stock. Separate offers are not joined.'].filter(Boolean).join(' ') : '';
  $('chart-container').hidden = !shown.length;
  $('chart-tooltip').hidden = true;
  $('history-values').hidden = !shown.length;
  $('history-value-rows').replaceChildren(...shown.flatMap(item => item.points.map(point => {
    const row = element('tr'); const date = centralTime(point.price_checked_at_utc);
    const dateLabel = state.demo ? `Example day ${Math.round((timestamp(point.price_checked_at_utc) - Date.UTC(2026, 0, 1)) / 86400000) + 1}` : `${date.date}, ${date.time}`;
    row.append(element('td', item.name), element('td', money(point.price_usd)), element('td', dateLabel), element('td', state.demo ? 'Sample' : (point.availability || 'unknown').replaceAll('_', ' ')));
    return row;
  })));
  if (shown.length) drawChart(shown);
  renderMedianChart();
}

function medianColor(id) { return modelColors[Math.max(0, families().findIndex(card => card.card_id === id)) % modelColors.length]; }

function medianLabel(item, point) {
  const date = centralTime(point.price_checked_at_utc);
  const stats = point.offer_count ? `${money(point.price_usd)} median · ${money(point.minimum_usd)}–${money(point.maximum_usd)} · ${point.offer_count} offers / ${point.model_count} models / ${point.retailer_count} retailers${point.coverage_changed ? ' · model coverage changed' : ''}` : 'No qualifying offers';
  return `${item.name} · ${stats} · ${date.date}, ${date.time}`;
}

function renderMedianChart() {
  const observations = [...state.history, ...state.latest.listings.map(row => row.last_successful_observation).filter(Boolean)];
  const series = familyMedianSeries(observations, state.cards, state.watchlist, state.medianDays);
  const shown = series.filter(item => !state.medianHidden.has(item.id));
  $('median-legend').replaceChildren(...families().map(card => {
    const button = element('button', undefined, 'legend-button'); button.type = 'button';
    button.setAttribute('aria-pressed', String(!state.medianHidden.has(card.card_id)));
    const swatch = element('span', undefined, 'legend-swatch'); swatch.style.backgroundColor = medianColor(card.card_id); swatch.setAttribute('aria-hidden', 'true');
    button.append(swatch, document.createTextNode(card.name));
    button.addEventListener('click', () => { if (state.medianHidden.has(card.card_id)) state.medianHidden.delete(card.card_id); else state.medianHidden.add(card.card_id); renderMedianChart(); });
    return button;
  }));
  const hasPoints = shown.some(item => item.points.some(point => point.retailer_count > 0));
  $('median-message').hidden = hasPoints;
  $('median-message').textContent = state.historyLoading ? 'Loading median price history…'
    : state.medianHidden.size === families().length ? 'Select a GPU above to show its median history.'
      : 'No qualifying in-stock price observations in this date range.';
  $('median-container').hidden = !hasPoints; $('median-tooltip').hidden = true;
  $('median-values').hidden = !shown.length;
  $('median-value-rows').replaceChildren(...shown.flatMap(item => item.points.map(point => {
    const row = element('tr'), date = centralTime(point.price_checked_at_utc);
    row.append(element('td', item.name), element('td', point.retailer_count ? money(point.price_usd) : 'Unavailable'),
      element('td', point.retailer_count ? `${money(point.minimum_usd)}–${money(point.maximum_usd)}` : '—'),
      element('td', `${point.offer_count} offers · ${point.model_count} models · ${point.retailer_count} retailers${point.coverage_changed ? ' · coverage changed' : ''}`), element('td', `${date.date}, ${date.time}`));
    return row;
  })));
  $('median-note').textContent = [state.historyError, 'Tracked-market median by GPU family and VRAM: every qualifying new, in-stock exact-model offer in that collection run has equal weight. Duplicate card/seller/retailer/location offers count once. Failed, stale, unavailable, and marketplace offers are excluded; no old prices carried forward. This is our tracked sample, not the entire market. Values show offer/model/retailer coverage; earlier history had fewer models. Gaps indicate changes in contributing model coverage. Each panel uses its own labeled price scale. Availability and sample changes can move the median without an individual price change. Independent of the filters above.'].filter(Boolean).join(' ');
  const container = $('median-container');
  container.querySelector('.median-grid')?.remove();
  $('median-price-chart').style.display = 'none';
  if (hasPoints) {
    const grid = element('div', undefined, 'median-grid'); container.append(grid);
    shown.forEach(item => {
      const valid = item.points.filter(p => p.price_usd !== null && Number.isFinite(p.price_usd));
      if (!valid.length) return;
      const panel = element('section', undefined, 'median-panel'), last = valid.at(-1);
      panel.append(element('h3', item.name), element('p', money(last.price_usd), 'median-current'),
        element('small', last.offer_count + ' offers · ' + last.model_count + ' models · ' + last.retailer_count + ' retailers'));
      const plot = svgElement('svg', { role: 'img', 'aria-label': item.name + ' median price history' });
      panel.append(plot); grid.append(panel); drawChart([item], true, plot);
    });
  }
}

function drawChart(series, median = false, panelSvg = null) {
  const svg = panelSvg || $(median ? 'median-price-chart' : 'price-chart');
  const color = median ? medianColor : colorFor;
  const tooltip = $(median ? 'median-tooltip' : 'chart-tooltip');
  const demo = !median && state.demo;
  const width = Math.max(240, Math.floor((panelSvg ? panelSvg.parentElement : $(median ? 'median-container' : 'chart-container')).getBoundingClientRect().width));
  const height = panelSvg ? 230 : width < 600 ? 260 : 320;
  const margin = { left: 72, right: 18, top: 25, bottom: 42 };
  const allPoints = series.flatMap(item => item.points);
  const points = allPoints.filter(point => typeof point.price_usd === 'number' && Number.isFinite(point.price_usd));
  const times = allPoints.map(point => timestamp(point.price_checked_at_utc));
  const prices = points.map(point => point.price_usd);
  let minTime = Math.min(...times), maxTime = Math.max(...times);
  if (minTime === maxTime) { minTime -= 43200000; maxTime += 43200000; }
  const padding = Math.max(5, (Math.max(...prices) - Math.min(...prices)) * .15);
  const rawStep = (Math.max(...prices) - Math.min(...prices) + padding * 2) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1,2,2.5,5,10].map(n => n * magnitude).find(n => n >= rawStep);
  const minPrice = Math.max(0, Math.floor((Math.min(...prices) - padding) / step) * step);
  const maxPrice = Math.ceil((Math.max(...prices) + padding) / step) * step;
  const x = time => margin.left + (time - minTime) / (maxTime - minTime) * (width - margin.left - margin.right);
  const y = price => margin.top + (maxPrice - price) / (maxPrice - minPrice) * (height - margin.top - margin.bottom);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren(svgElement('title', { ...(panelSvg ? {} : {id: median ? 'median-chart-title' : 'chart-title'}) }, median ? 'All GPU models median in-stock price history' : demo ? 'Illustrative GPU price history' : 'Collected GPU price history'),
    svgElement('desc', { ...(panelSvg ? {} : {id: median ? 'median-chart-desc' : 'chart-desc'}) }, median ? 'Median prices in US dollars per model and collection run. The values table includes price ranges, retailer counts, and dates.' : 'Retailer prices in US dollars over time. Exact values are available in the chart values table below.'));
  svg.append(svgElement('text', { x: 4, y: 13, fill: '#a3b2c8', 'font-size': 11 }, 'USD'));
  for (let value = minPrice; value <= maxPrice + step / 100; value += step) {
    svg.append(svgElement('line', { x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value), stroke: '#29374b' }),
      svgElement('text', { x: margin.left - 10, y: y(value) + 4, 'text-anchor': 'end', fill: '#a3b2c8', 'font-size': 11 }, new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:step < 1 ? 2 : 0}).format(value)));
  }
  for (let i = 0; i < 3; i++) {
    const time = minTime + (maxTime - minTime) * i / 2;
    const label = demo ? `Day ${1 + Math.round((state.days - 1) * i / 2)}`
      : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).format(time);
    svg.append(svgElement('text', { x: x(time), y: height - 17, 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fill: '#a3b2c8', 'font-size': 11 }, label));
  }
  const hitPoints = [];
  series.forEach(item => {
    const groups = new Map();
    item.points.forEach(point => {
      if (point.price_usd === null) return;
      if (point.offer_id) { if (!groups.has(point.offer_id)) groups.set(point.offer_id, []); groups.get(point.offer_id).push(point); }
    });
    for (const group of groups.values()) {
      if (group.length > 1) svg.append(svgElement('polyline', { points: group.map(point => `${x(timestamp(point.price_checked_at_utc))},${y(point.price_usd)}`).join(' '), fill: 'none', stroke: color(item.id), 'stroke-width': 2 }));
    }
    item.points.forEach(point => {
      if (point.price_usd === null) return;
      const px = x(timestamp(point.price_checked_at_utc)), py = y(point.price_usd);
      const dot = svgElement('circle', { cx: px, cy: py, r: 3.5, fill: point.availability === 'in_stock' ? color(item.id) : '#121b29', stroke: color(item.id), 'stroke-width': 1.5 });
      const date = centralTime(point.price_checked_at_utc);
      const label = median ? medianLabel(item, point) : demo ? `${item.name} · ${money(point.price_usd)} · sample data` : `${item.name} · ${money(point.price_usd)} · ${date.date}, ${date.time} · ${(point.availability || 'unknown').replaceAll('_', ' ')}`;
      dot.append(svgElement('title', {}, label)); svg.append(dot); hitPoints.push({ x: px, y: py, label });
    });
  });
  // A single plot overlay provides hover/touch inspection without hundreds of focus stops.
  const overlay = svgElement('rect', { x: margin.left, y: margin.top - 10, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom + 20, fill: 'transparent' });
  const showPoint = event => {
    const bounds = svg.getBoundingClientRect(); const px = (event.clientX - bounds.left) * width / bounds.width;
    const py = (event.clientY - bounds.top) * height / bounds.height;
    const nearest = hitPoints.reduce((best, point) => (point.x - px) ** 2 + (point.y - py) ** 2 < (best.x - px) ** 2 + (best.y - py) ** 2 ? point : best);
    tooltip.textContent = nearest.label; tooltip.hidden = false;
  };
  overlay.addEventListener('pointermove', showPoint); overlay.addEventListener('pointerdown', showPoint);
  overlay.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') tooltip.hidden = true; });
  svg.append(overlay);
}

$('refresh').addEventListener('click', loadData);
for (const id of ['retailer-filter', 'stock-filter']) $(id).addEventListener('change', () => {
  state.selectedListing = null; renderTable(); renderChart();
});
document.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => {
  state.days = Number(button.dataset.days);
  document.querySelectorAll('[data-days]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderChart(); if (state.watchlist) loadHistory();
}));
$('demo-toggle').addEventListener('click', () => { state.demo = !state.demo; state.hiddenSeries.clear(); renderChart(); });
document.querySelectorAll('[data-median-days]').forEach(button => button.addEventListener('click', () => {
  state.medianDays = Number(button.dataset.medianDays);
  document.querySelectorAll('[data-median-days]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderMedianChart(); if (state.watchlist) loadHistory();
}));
let resizeFrame;
const chartWidths = new Map();
const chartResize = new ResizeObserver(entries => {
  let changed = false;
  for (const entry of entries) {
    const width = Math.floor(entry.contentRect.width);
    if (chartWidths.get(entry.target) !== width) { chartWidths.set(entry.target, width); changed = true; }
  }
  // Showing a tooltip changes height, not the plotting width.
  if (changed && state.watchlist) { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(renderChart); }
});
chartResize.observe($('chart-container')); chartResize.observe($('median-container'));
loadData();

