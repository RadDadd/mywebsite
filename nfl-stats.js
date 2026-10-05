// Use the same backend as the chatbot, including when hosted on GitHub Pages.
const NFL_API_URL = 'https://mywebsite-raddadd.vercel.app/api/nfl-stats';
const byId = id => document.getElementById(id);
const season = byId('season');
const week = byId('week');
const team = byId('team');
const position = byId('position');
const search = byId('playerSearch');
const sort = byId('sort');
const status = byId('statsStatus');
const tbody = byId('statsBody');
let players = [];
let loaded = null;
let activeRequest;
const now = new Date();
const latestSeason = now.getUTCFullYear() - (now.getUTCMonth() < 7 ? 1 : 0);
for (let year = latestSeason; year >= 1999; year--) season.add(new Option(String(year), String(year)));

function render() {
    if (!loaded) return;
    const query = search.value.trim().toLowerCase();
    const matches = players.filter(player =>
        (team.value === 'all' || player.teams.includes(team.value)) &&
        (position.value === 'all' || player.position === position.value) &&
        player.name.toLowerCase().includes(query));
    matches.sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name) : b[sort.value] - a[sort.value] || a.name.localeCompare(b.name));
    const fragment = document.createDocumentFragment();
    for (const player of matches) {
        const row = document.createElement('tr');
        for (const value of [player.name, player.teams.join(' / '), player.position, player.games, player.passingYards, player.rushingYards, player.receivingYards, player.touchdowns]) {
            const cell = document.createElement('td');
            cell.textContent = typeof value === 'number' ? value.toLocaleString() : value;
            row.appendChild(cell);
        }
        fragment.appendChild(row);
    }
    if (!matches.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 8;
        cell.textContent = 'No players match these filters.';
        row.appendChild(cell); fragment.appendChild(row);
    }
    tbody.replaceChildren(fragment);
    const period = loaded.week === null ? 'Season totals' : `Week ${loaded.week}`;
    byId('statsCaption').textContent = `${loaded.season} · ${period} · Regular season`;
    status.textContent = `${matches.length} players · ${loaded.season} · ${period}`;
}

async function loadStats() {
    activeRequest?.abort();
    const controller = new AbortController();
    activeRequest = controller;
    loaded = null; players = [];
    tbody.replaceChildren();
    byId('dataTime').textContent = '';
    status.textContent = 'Loading NFL stats…';
    byId('statsTable').setAttribute('aria-busy', 'true');
    byId('loadStats').disabled = true;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const url = new URL(NFL_API_URL);
        url.searchParams.set('season', season.value);
        url.searchParams.set('week', week.value);
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load NFL stats.');
        if (!Array.isArray(data.players) || !Array.isArray(data.availableWeeks)) throw new Error('The stats service returned an unexpected response.');
        if (activeRequest !== controller) return;
        const selectedWeek = week.value;
        week.replaceChildren(new Option('Season totals', 'all'));
        data.availableWeeks.forEach(value => week.add(new Option(`Week ${value}`, String(value))));
        week.value = selectedWeek;
        const selectedTeam = team.value;
        team.replaceChildren(new Option('All teams', 'all'));
        [...new Set(data.players.flatMap(player => player.teams))].sort().forEach(value => team.add(new Option(value, value)));
        team.value = [...team.options].some(option => option.value === selectedTeam) ? selectedTeam : 'all';
        players = data.players; loaded = data;
        byId('dataTime').textContent = `Data fetched: ${new Date(data.fetchedAt).toLocaleString()}. nflverse may publish later corrections.`;
        render();
    } catch (error) {
        if (activeRequest !== controller) return;
        status.textContent = error.name === 'AbortError' ? 'The request took too long. Click Load stats to try again.' : error instanceof SyntaxError ? 'The stats endpoint is not ready yet. Try again after deployment finishes.' : `${error.message} Click Load stats to try again.`;
    } finally {
        clearTimeout(timer);
        if (activeRequest === controller) {
            byId('loadStats').disabled = false;
            byId('statsTable').setAttribute('aria-busy', 'false');
        }
    }
}

byId('statsFilters').addEventListener('submit', event => { event.preventDefault(); loadStats(); });
season.addEventListener('change', () => { week.replaceChildren(new Option('Season totals', 'all')); loadStats(); });
week.addEventListener('change', loadStats);
for (const control of [team, position, sort]) control.addEventListener('change', render);
search.addEventListener('input', render);
loadStats();
