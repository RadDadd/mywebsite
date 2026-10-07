import { currentSeason, summarize } from './nfl-data.mjs';

export const metrics = {
    touchdowns: 'passing + rushing + receiving TDs', rushingTDs: 'rushing TDs', receivingTDs: 'receiving TDs', passingTDs: 'passing TDs',
    passingYards: 'passing yards', rushingYards: 'rushing yards', receivingYards: 'receiving yards', totalYards: 'rushing + receiving yards',
    receptions: 'receptions', targets: 'targets', carries: 'carries', fantasyPPR: 'PPR fantasy points'
};

export const querySchema = {
    type: 'object',
    properties: {
        action: { type: 'string', enum: ['rank', 'trend', 'player', 'unsupported'] },
        season: { type: 'integer' }, week: { type: 'integer', description: '0 for season totals or latest available week for trends; otherwise 1–18' },
        metric: { type: 'string', enum: Object.keys(metrics) },
        position: { type: 'string', enum: ['all', 'QB', 'RB', 'WR', 'TE', 'FB'] },
        team: { type: 'string', description: 'NFL team abbreviation or all' },
        player: { type: 'string', description: 'Player name, or empty string' },
        limit: { type: 'integer' }, direction: { type: 'string', enum: ['up', 'down'] }
    },
    required: ['action', 'season', 'week', 'metric', 'position', 'team', 'player', 'limit', 'direction'], additionalProperties: false
};

export function validateQuery(q) {
    if (!q || !['rank', 'trend', 'player', 'unsupported'].includes(q.action) || !Number.isInteger(q.season) || q.season < 1999 || q.season > currentSeason() ||
        !Number.isInteger(q.week) || q.week < 0 || q.week > 18 || !Object.hasOwn(metrics, q.metric) ||
        !['all', 'QB', 'RB', 'WR', 'TE', 'FB'].includes(q.position) || typeof q.team !== 'string' || !/^(all|[A-Z]{2,3})$/.test(q.team) ||
        typeof q.player !== 'string' || q.player.length > 100 || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 10 || !['up', 'down'].includes(q.direction)) {
        throw new Error('Invalid stats query');
    }
    return q;
}

const fmt = n => Number(n.toFixed(2)).toLocaleString('en-US');
function filterPlayers(players, q) {
    return players.filter(p => (q.position === 'all' || p.position === q.position) && (q.team === 'all' || p.teams.includes(q.team)) &&
        (!q.player || p.name.toLowerCase().includes(q.player.toLowerCase())));
}

export function answerQuery(data, q) {
    validateQuery(q);
    if (q.action === 'unsupported') return { reply: 'I can look up regular-season offensive player stats, rank players, and compare recent weekly performance. Try “Which RB had the most TDs in Week 3?” or “Which WRs are trending up in receiving yards?” Injury news, live scores, defense rankings, and future projections are not in this dataset.' };
    const all = summarize(data.rows, q.season);
    const availableWeeks = all.availableWeeks;
    const scope = `${q.season} regular season${q.position === 'all' ? '' : ` · ${q.position}`}${q.team === 'all' ? '' : ` · ${q.team}`}`;
    const source = { season: q.season, week: q.week || null, fetchedAt: data.fetchedAt, url: data.source, metric: metrics[q.metric] };
    if (!availableWeeks.length) return { reply: `No regular-season offensive stats are published for ${q.season} yet.`, source };
    if (q.week && !availableWeeks.includes(q.week)) return { reply: `Week ${q.week} is not available for ${q.season} yet. Available weeks: ${availableWeeks.join(', ')}.`, source };
    if (q.action === 'trend') {
        const end = q.week || Math.max(...availableWeeks);
        const window = Math.min(2, Math.floor(end / 2));
        if (window < 1) return { reply: 'I need at least two completed weeks to compare trends.', source };
        const recentWeeks = Array.from({ length: window }, (_, i) => end - window + 1 + i);
        const priorWeeks = recentWeeks.map(w => w - window);
        if (![...recentWeeks, ...priorWeeks].every(w => availableWeeks.includes(w))) return { reply: 'The comparison weeks are not all published yet. Try an earlier week.', source };
        const period = weeks => summarize(data.rows.filter(r => weeks.includes(Number(r.week))), q.season).players;
        const prior = new Map(period(priorWeeks).map(p => [p.id, p]));
        const rising = filterPlayers(period(recentWeeks), q).flatMap(p => {
            const before = prior.get(p.id);
            if (!before || p.games < window || before.games < window) return [];
            const baseline = before[q.metric] / before.games, recent = p[q.metric] / p.games;
            return [{ ...p, baseline, recent, change: recent - baseline }];
        }).filter(p => q.direction === 'down' ? p.change < 0 : p.change > 0)
            .sort((a, b) => q.direction === 'down' ? a.change - b.change : b.change - a.change);
        const top = rising.slice(0, q.limit);
        return { reply: `${scope} · Trending ${q.direction} in ${metrics[q.metric]}\nComparing Weeks ${priorWeeks.join('–')} with Weeks ${recentWeeks.join('–')} by average per recorded game. Players must have a stats row in every comparison week.\n\n${top.length ? top.map((p, i) => `${i + 1}. ${p.name} (${p.teams.join('/')}, ${p.position}): ${fmt(p.baseline)} → ${fmt(p.recent)} per game (${p.change > 0 ? '+' : ''}${fmt(p.change)}).`).join('\n') : 'No players match this trend and these filters.'}\n\nThis describes recorded performance, not a prediction. Bye weeks and missing stats rows exclude a player from this comparison.`, source: { ...source, priorWeeks, recentWeeks }, results: top };
    }
    const totals = q.week ? summarize(data.rows, q.season, q.week) : all;
    const players = filterPlayers(totals.players, q).sort((a, b) => b[q.metric] - a[q.metric] || a.name.localeCompare(b.name));
    const period = q.week ? `Week ${q.week}` : `Season totals through Week ${Math.max(...availableWeeks)}`;
    if (!players.length) return { reply: `${scope} · ${period}\nNo players match that name or those filters. Try the full player name.`, source };
    if (q.action === 'player') {
        const top = players.slice(0, q.limit);
        return { reply: `${scope} · ${period}\n\n${top.map(p => `${p.name} (${p.teams.join('/')}, ${p.position}): ${fmt(p.passingYards)} passing yards, ${fmt(p.rushingYards)} rushing yards, ${fmt(p.receivingYards)} receiving yards; ${p.passingTDs} passing TDs, ${p.rushingTDs} rushing TDs, ${p.receivingTDs} receiving TDs; ${p.receptions} catches on ${p.targets} targets; ${p.carries} carries; ${fmt(p.fantasyPPR)} PPR points.`).join('\n\n')}`, source, results: top };
    }
    let top = players.slice(0, q.limit);
    const cutoff = top.at(-1)?.[q.metric];
    const tied = players.filter(p => p[q.metric] === cutoff);
    // Show tied winners together, with a hard response bound.
    if (q.limit === 1 && cutoff > 0) top = players.filter(p => p[q.metric] === cutoff).slice(0, 10);
    const reply = `${scope} · ${period}\nRanked by ${metrics[q.metric]} (highest first):\n\n${top.map(p => `${p.name} (${p.teams.join('/')}, ${p.position}): ${fmt(p[q.metric])} ${metrics[q.metric]}.`).join('\n')}${tied.length > 1 ? '\nTies share the same stat value.' : ''}${q.limit === 1 && tied.length > 10 ? `\n${tied.length} players tied; showing the first 10 alphabetically.` : ''}\n\nStats are from nflverse; games still being played may not be included.${q.team !== 'all' && !q.week ? ' Traded players’ totals include their full season across teams.' : ''}`;
    return { reply, source, results: top };
}
