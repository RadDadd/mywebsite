import {
  DATA_BASE, buildRows, filterRows, lowestAvailable, historyPaths, historySeries,
  previousChange, centralTime, safeProductUrl, validateDocuments, timestamp
} from './lib/gpu-tracker-data.mjs';

const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const colors = ['#75b5ff', '#c3a1ff', '#79ddba', '#f0cb8b'];
const state = { cards: [], watchlist: null, latest: null, selectedCard: null, selectedListing: null,
  days: 30, history: [], historyError: '', historyLoading: false, demo: false, hiddenSeries: new Set() };
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
  const response = await fetch(DATA_BASE + path, {
    mode: 'cors', credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Data request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 2000000) throw new Error('Data file exceeds the supported size');
  return JSON.parse(text);
}

function currentCard() { return state.cards.find(card => card.card_id === state.selectedCard); }
function allRows() { return state.watchlist ? buildRows(state.watchlist, state.latest, state.selectedCard) : []; }
function shownRows() { return filterRows(allRows(), $('retailer-filter').value, $('stock-filter').checked); }
function colorFor(id) {
  const row = state.watchlist.listings.find(listing => listing.listing_id === id);
  const index = state.watchlist.retailers.findIndex(retailer => retailer.retailer_id === row?.retailer_id);
  return colors[Math.max(0, index) % colors.length];
}

function renderPicker() {
  $('card-picker').replaceChildren(...state.cards.map(card => {
    const button = element('button', undefined, 'gpu-choice');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(card.card_id === state.selectedCard));
    button.append(element('strong', card.gpu_model), element('small', `${card.card_manufacturer} ${card.series} · ${card.specs?.vram_gb ?? '—'} GB ${card.specs?.memory_type ?? ''}`));
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
  const labels = [card.full_card_name, card.manufacturer_part_number];
  if (specs.vram_gb) labels.push(`${specs.vram_gb} GB ${specs.memory_type ?? ''}`);
  if (specs.memory_bus_bits) labels.push(`${specs.memory_bus_bits}-bit`);
  if (specs.core_count) labels.push(`${specs.core_count.toLocaleString()} ${specs.core_type ?? 'cores'}`);
  if (specs.boost_clock_mhz) labels.push(`${specs.boost_clock_mhz.toLocaleString()} MHz boost`);
  if (specs.recommended_psu_w) labels.push(`${specs.recommended_psu_w} W recommended PSU`);
  $('card-specs').replaceChildren(...labels.filter(Boolean).map(text => element('span', text, 'spec')));
  $('specs-note').textContent = card.specs_status?.includes('pending') ? 'Starter specifications · manufacturer verification pending.' : '';
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
  const rows = shownRows();
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
    name.append(element('span', retailer.name, 'retailer-name'), element('small', currentCard().full_card_name));
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
    history.setAttribute('aria-label', `Show ${retailer.name} history`);
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
  $('offer-count').textContent = `${rows.length} retailer offer${rows.length === 1 ? '' : 's'} · exact model match`;
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
    if (!state.cards.some(card => card.card_id === state.selectedCard)) state.selectedCard = state.cards[0].card_id;
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
    const paths = historyPaths(index, state.days);
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
  const observations = [...state.history, ...rows.map(row => row.observation).filter(Boolean)];
  const series = state.demo ? sampleSeries(rows) : historySeries(observations, rows, state.days);
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
    : shown.length ? [state.historyError, 'Dots are successful observations; hollow dots indicate unavailable or unknown stock. Separate offers are not joined.'].filter(Boolean).join(' ') : '';
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
}

function drawChart(series) {
  const svg = $('price-chart');
  const width = Math.max(240, Math.floor($('chart-container').getBoundingClientRect().width));
  const height = width < 600 ? 240 : 280;
  const margin = { left: 72, right: 18, top: 25, bottom: 42 };
  const points = series.flatMap(item => item.points);
  const times = points.map(point => timestamp(point.price_checked_at_utc));
  const prices = points.map(point => point.price_usd);
  let minTime = Math.min(...times), maxTime = Math.max(...times);
  if (minTime === maxTime) { minTime -= 43200000; maxTime += 43200000; }
  const padding = Math.max(5, (Math.max(...prices) - Math.min(...prices)) * .15);
  const minPrice = Math.max(0, Math.min(...prices) - padding), maxPrice = Math.max(...prices) + padding;
  const x = time => margin.left + (time - minTime) / (maxTime - minTime) * (width - margin.left - margin.right);
  const y = price => margin.top + (maxPrice - price) / (maxPrice - minPrice) * (height - margin.top - margin.bottom);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren(svgElement('title', { id: 'chart-title' }, state.demo ? 'Illustrative GPU price history' : 'Collected GPU price history'),
    svgElement('desc', { id: 'chart-desc' }, 'Retailer prices in US dollars over time. Exact values are available in the chart values table below.'));
  svg.append(svgElement('text', { x: 4, y: 13, fill: '#a3b2c8', 'font-size': 11 }, 'USD'));
  for (let i = 0; i < 4; i++) {
    const value = minPrice + (maxPrice - minPrice) * i / 3;
    svg.append(svgElement('line', { x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value), stroke: '#29374b' }),
      svgElement('text', { x: margin.left - 10, y: y(value) + 4, 'text-anchor': 'end', fill: '#a3b2c8', 'font-size': 11 }, money(value)));
  }
  for (let i = 0; i < 3; i++) {
    const time = minTime + (maxTime - minTime) * i / 2;
    const label = state.demo ? `Day ${1 + Math.round((state.days - 1) * i / 2)}`
      : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).format(time);
    svg.append(svgElement('text', { x: x(time), y: height - 17, 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fill: '#a3b2c8', 'font-size': 11 }, label));
  }
  const hitPoints = [];
  series.forEach(item => {
    const groups = new Map();
    item.points.forEach(point => {
      if (point.offer_id) { if (!groups.has(point.offer_id)) groups.set(point.offer_id, []); groups.get(point.offer_id).push(point); }
    });
    for (const group of groups.values()) {
      if (group.length > 1) svg.append(svgElement('polyline', { points: group.map(point => `${x(timestamp(point.price_checked_at_utc))},${y(point.price_usd)}`).join(' '), fill: 'none', stroke: colorFor(item.id), 'stroke-width': 2 }));
    }
    item.points.forEach(point => {
      const px = x(timestamp(point.price_checked_at_utc)), py = y(point.price_usd);
      const dot = svgElement('circle', { cx: px, cy: py, r: 3.5, fill: point.availability === 'in_stock' ? colorFor(item.id) : '#121b29', stroke: colorFor(item.id), 'stroke-width': 1.5 });
      const date = centralTime(point.price_checked_at_utc);
      const label = state.demo ? `${item.name} · ${money(point.price_usd)} · sample data` : `${item.name} · ${money(point.price_usd)} · ${date.date}, ${date.time} · ${(point.availability || 'unknown').replaceAll('_', ' ')}`;
      dot.append(svgElement('title', {}, label)); svg.append(dot); hitPoints.push({ x: px, y: py, label });
    });
  });
  // A single plot overlay provides hover/touch inspection without hundreds of focus stops.
  const overlay = svgElement('rect', { x: margin.left, y: margin.top - 10, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom + 20, fill: 'transparent' });
  const showPoint = event => {
    const bounds = svg.getBoundingClientRect(); const px = (event.clientX - bounds.left) * width / bounds.width;
    const py = (event.clientY - bounds.top) * height / bounds.height;
    const nearest = hitPoints.reduce((best, point) => (point.x - px) ** 2 + (point.y - py) ** 2 < (best.x - px) ** 2 + (best.y - py) ** 2 ? point : best);
    $('chart-tooltip').textContent = nearest.label; $('chart-tooltip').hidden = false;
  };
  overlay.addEventListener('pointermove', showPoint); overlay.addEventListener('pointerdown', showPoint);
  overlay.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') $('chart-tooltip').hidden = true; });
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
let resizeFrame;
new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(renderChart); }).observe($('chart-container'));
loadData();
