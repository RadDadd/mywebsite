import test from 'node:test';
import assert from 'node:assert/strict';
import stats, { parseCSV, summarize } from '../api/nfl-stats.mjs';

const header = 'player_id,player_display_name,position,season,week,season_type,game_id,team,passing_yards,rushing_yards,receiving_yards,passing_tds,rushing_tds,receiving_tds';
const csv = `${header}\r\n1,"Player, One",QB,2026,1,REG,g1,KC,250,-3,0,2,0,0\r\n1,"Player, One",QB,2026,2,REG,g2,BUF,300,10,0,1,1,0\r\n2,Receiver,WR,2026,1,REG,g1,KC,0,0,120,0,0,2\r\n1,Player,QB,2026,19,POST,g3,BUF,900,0,0,9,0,0\r\n3,Defender,CB,2026,1,REG,g1,KC,0,0,0,0,0,0\r\n`;

test('CSV quotes and totals preserve names, negative yards, trades, and regular season only', () => {
    const data = summarize(parseCSV(csv), 2026);
    assert.deepEqual(data.availableWeeks, [1, 2]);
    assert.equal(data.players.length, 2);
    const player = data.players[0];
    assert.equal(player.name, 'Player, One');
    assert.equal(player.passingYards, 550);
    assert.equal(player.rushingYards, 7);
    assert.equal(player.touchdowns, 4);
    assert.equal(player.games, 2);
    assert.deepEqual(player.teams, ['KC', 'BUF']);
    const weekly = summarize(parseCSV(csv), 2026, 1);
    assert.equal(weekly.players[0].passingYards, 250);
    assert.equal(weekly.players[0].games, 1);
    assert.equal(summarize(parseCSV(csv), 2026, 4).players.length, 0);
});

test('malformed data is rejected; escaped quotes and embedded newlines work', () => {
    assert.throws(() => parseCSV('bad,data\n1,2'), /Unexpected/);
    assert.throws(() => parseCSV(`${header}\n"unterminated`), /Malformed/);
    const quoted = parseCSV(`${header}\n1,"A ""Nickname""\nOne",QB,2026,1,REG,g1,KC,0,0,0,0,0,0`);
    assert.equal(quoted[0].player_display_name, 'A "Nickname"\nOne');
});

test('API validates input, caches successful downloads, supports CORS, and handles missing upstream', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async url => {
        calls++;
        if (url.includes('2024')) return new Response('missing', { status: 404 });
        return new Response(csv);
    };
    const request = query => stats.fetch(new Request(`https://site.test/api/nfl-stats?${query}`));
    try {
        assert.equal((await request('season=2026&week=0')).status, 400);
        assert.equal((await request('season=2026&week=2.5')).status, 400);
        assert.equal((await request('season=2099')).status, 400);
        assert.equal(calls, 0);
        const response = await request('season=2026');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        assert.equal((await response.json()).players[0].passingYards, 550);
        const weekly = await request('season=2026&week=1');
        assert.equal((await weekly.json()).players[0].passingYards, 250);
        assert.equal(calls, 1);
        const missing = await request('season=2024');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers.get('cache-control'), 'no-store');
        assert.equal((await stats.fetch(new Request('https://site.test/api/nfl-stats', { method: 'OPTIONS' }))).status, 204);
        assert.equal((await stats.fetch(new Request('https://site.test/api/nfl-stats', { method: 'POST' }))).status, 405);
    } finally { globalThis.fetch = originalFetch; }
});
