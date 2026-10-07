import { currentSeason, loadSeason, summarize } from '../lib/nfl-data.mjs';
export { currentSeason, parseCSV, summarize } from '../lib/nfl-data.mjs';

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
