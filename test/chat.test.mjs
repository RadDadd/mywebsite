import test from 'node:test';
import assert from 'node:assert/strict';
import chat from '../api/chat.mjs';
import { parseCSV } from '../lib/nfl-data.mjs';
import { answerQuery, validateQuery } from '../lib/nfl-query.mjs';
const header='player_id,player_display_name,position,season,week,season_type,game_id,team,passing_yards,rushing_yards,receiving_yards,passing_tds,rushing_tds,receiving_tds,receptions,targets,carries,fantasy_points_ppr';
const rows=[];
for(let week=1;week<=4;week++){
 rows.push(`a,Runner A,RB,2026,${week},REG,g${week},KC,0,${week<3?40:100},20,0,${week===3?1:0},${week===3?2:0},2,3,15,${week<3?8:20}`);
 rows.push(`b,Runner B,RB,2026,${week},REG,g${week},BUF,0,80,30,0,${week===3?3:0},0,3,4,16,15`);
 rows.push(`c,Receiver,WR,2026,${week},REG,g${week},KC,0,0,150,0,0,4,8,10,0,25`);
}
const csv=header+'\n'+rows.join('\n');
const data={rows:parseCSV(csv),source:'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv',fetchedAt:'2026-10-06T00:00:00Z'};
const plan={action:'rank',season:2026,week:3,metric:'touchdowns',position:'RB',team:'all',player:'',limit:1,direction:'up'};
const request=(body,origin='https://raddata.dev')=>new Request('https://site.test/api/chat',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('RB TD leaders include receiving TDs and all tied winners',()=>{
 const result=answerQuery(data,plan);assert.equal(result.results.length,2);assert.equal(result.results[0].touchdowns,3);
 assert.match(result.reply,/Runner A/);assert.match(result.reply,/Runner B/);assert.doesNotMatch(result.reply,/Receiver \(/);
 const rushing=answerQuery(data,{...plan,metric:'rushingTDs'});assert.equal(rushing.results.length,1);assert.equal(rushing.results[0].name,'Runner B');
});
test('trend uses defined weekly windows and excludes missing-game comparisons',()=>{
 const r=answerQuery(data,{...plan,action:'trend',week:0,metric:'fantasyPPR',limit:5});
 assert.deepEqual(r.source.priorWeeks,[1,2]);assert.deepEqual(r.source.recentWeeks,[3,4]);
 assert.equal(r.results.length,1);assert.equal(r.results[0].name,'Runner A');assert.equal(r.results[0].baseline,8);assert.equal(r.results[0].recent,20);assert.equal(r.results[0].change,12);assert.match(r.reply,/not a prediction/);
 const missing={...data,rows:data.rows.filter(r=>!(r.player_id==='a'&&r.week==='1'))};assert.equal(answerQuery(missing,{...plan,action:'trend',week:0,metric:'fantasyPPR'}).results.length,0);
});
test('unsupported requests, missing weeks, bad plans, and absent players are handled honestly',()=>{
 assert.match(answerQuery(data,{...plan,action:'unsupported'}).reply,/not in this dataset/);
 assert.match(answerQuery(data,{...plan,week:18}).reply,/not available/);
 assert.match(answerQuery(data,{...plan,action:'player',player:'Nobody'}).reply,/No players/);
 assert.throws(()=>validateQuery({...plan,metric:'__proto__'}));assert.throws(()=>validateQuery({...plan,season:2099}));
});
test('chat validates request and origin before invoking Gemini',async()=>{
 assert.equal((await chat.fetch(request({messages:[{role:'user',content:'Hi'}]},'https://other.example'))).status,403);
 assert.equal((await chat.fetch(request({messages:[{role:'user',content:'x'.repeat(1201)}]}))).status,400);
 assert.equal((await chat.fetch(request({messages:[{role:'user',content:'Hi'}],context:{season:2099,week:0}}))).status,400);
});
test('chat executes a Gemini query plan against NFL data',async()=>{
 const original=globalThis.fetch,key=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test-key';let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;
  if(url.includes('generativelanguage')){
   const body=JSON.parse(options.body);assert.equal(body.generationConfig.responseMimeType,'application/json');assert.ok(body.generationConfig.responseJsonSchema);assert.match(body.systemInstruction.parts[0].text,/Default scope from the page: season 2026, week 0/);
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(plan)}]}}]});
  }
  assert.match(url,/stats_player_week_2026.csv/);return new Response(csv);
 };
 try{
  const r=await chat.fetch(request({messages:[{role:'user',content:'Which RB has the most TDs in week 3?'}],context:{season:2026,week:0}}));assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  const body=await r.json();assert.equal(body.results.length,2);assert.equal(body.source.season,2026);assert.equal(calls,2);
 }finally{globalThis.fetch=original;if(key===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=key;}
});
