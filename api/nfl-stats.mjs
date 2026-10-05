// Public NFL statistics: no API key or database needed.
const TTL = 55 * 60 * 1000;
const cache = new Map();
const pending = new Map();
const positions = new Set(['QB', 'RB', 'FB', 'WR', 'TE']);

export function currentSeason() {
    const now = new Date();
    return now.getUTCFullYear() - (now.getUTCMonth() < 7 ? 1 : 0);
}

// Handle quoted commas, escaped quotes, CRLF, and embedded newlines.
export function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (quoted && text[i + 1] === '"') { field += '"'; i++; }
            else quoted = !quoted;
        } else if (char === ',' && !quoted) {
            row.push(field); field = '';
        } else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            if (row.some(value => value !== '')) rows.push(row);
            row = []; field = '';
        } else field += char;
    }
    if (quoted) throw new Error('Malformed CSV');
    if (field || row.length) { row.push(field); rows.push(row); }
    const headers = rows.shift() || [];
    const required = ['player_id', 'season', 'week', 'season_type', 'passing_yards', 'rushing_yards', 'receiving_yards'];
    if (!required.every(key => headers.includes(key)) || (!headers.includes('team') && !headers.includes('recent_team'))) {
        throw new Error('Unexpected NFL data format');
    }
    return rows.map(values => {
        if (values.length !== headers.length) throw new Error('Incomplete CSV row');
        return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
    });
}

async function download(season) {
    const source = `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
    const upstream = await fetch(source, { signal: AbortSignal.timeout(20000) });
    if (!upstream.ok) {
        const error = new Error(upstream.status === 404 ? 'No statistics published for that season yet.' : 'NFL data is temporarily unavailable. Please try again.');
        error.status = upstream.status === 404 ? 404 : 502;
        throw error;
    }
    const reader = upstream.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('NFL data too large'); }
        chunks.push(value);
    }
    const rows = parseCSV(Buffer.concat(chunks).toString('utf8'));
    const result = { rows, source, fetchedAt: new Date().toISOString() };
    cache.delete(season);
    cache.set(season, { ...result, expires: Date.now() + TTL });
    while (cache.size > 3) cache.delete(cache.keys().next().value);
    return result;
}

async function loadSeason(season) {
    const entry = cache.get(season);
    if (entry && entry.expires > Date.now()) return entry;
    if (!pending.has(season)) pending.set(season, download(season).finally(() => pending.delete(season)));
    return pending.get(season);
}

export function summarize(rows, season, week = null) {
    const eligible = rows.filter(row => Number(row.season) === season && row.season_type === 'REG' && positions.has(row.position));
    const availableWeeks = [...new Set(eligible.map(row => Number(row.week)))].sort((a, b) => a - b);
    const players = new Map();
    for (const row of eligible.sort((a, b) => Number(a.week) - Number(b.week))) {
        if (week !== null && Number(row.week) !== week) continue;
        let player = players.get(row.player_id);
        if (!player) {
            player = { id: row.player_id, name: row.player_display_name || row.player_name, team: '', teams: [], position: row.position, games: 0, passingYards: 0, rushingYards: 0, receivingYards: 0, touchdowns: 0, gameIds: new Set() };
            players.set(row.player_id, player);
        }
        const team = row.team || row.recent_team;
        player.team = team;
        if (!player.teams.includes(team)) player.teams.push(team);
        player.gameIds.add(row.game_id || `${row.season_type}-${row.week}`);
        const number = key => Number.isFinite(Number(row[key])) ? Number(row[key]) : 0;
        player.passingYards += number('passing_yards');
        player.rushingYards += number('rushing_yards');
        player.receivingYards += number('receiving_yards');
        player.touchdowns += number('passing_tds') + number('rushing_tds') + number('receiving_tds');
    }
    return { availableWeeks, players: [...players.values()].map(({ gameIds, ...player }) => ({ ...player, games: gameIds.size })).sort((a, b) => b.passingYards - a.passingYards || a.name.localeCompare(b.name)) };
}

function json(body, status = 200) {
    return Response.json(body, { status, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': status === 200 ? 'public, max-age=60, s-maxage=300' : 'no-store'
    } });
}

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const params = new URL(request.url).searchParams;
        const seasonText = params.get('season') ?? String(currentSeason());
        const weekText = params.get('week');
        const season = Number(seasonText);
        const week = weekText === null || weekText === 'all' ? null : Number(weekText);
        if (!/^\d{4}$/.test(seasonText) || season < 1999 || season > currentSeason() ||
            (week !== null && (!/^\d{1,2}$/.test(weekText) || week < 1 || week > 18))) {
            return json({ error: 'Choose a valid season and regular-season week.' }, 400);
        }
        try {
            const data = await loadSeason(season);
            return json({ season, week, seasonType: 'REG', fetchedAt: data.fetchedAt, source: data.source, ...summarize(data.rows, season, week) });
        } catch (error) {
            console.error('NFL stats request failed:', error.name);
            return json({ error: error.status ? error.message : 'NFL data is temporarily unavailable. Please try again.' }, error.status || 502);
        }
    }
};
