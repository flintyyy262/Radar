// Загружает матчи CS2 из PandaScore, считает рейтинг Эло и шансы на победу,
// сохраняет всё в data/matches.json для сайта.
// Запуск: PANDASCORE_TOKEN=... node scripts/update.mjs
import { writeFile, mkdir } from "node:fs/promises";

const TOKEN = process.env.PANDASCORE_TOKEN;
const API = "https://api.pandascore.co/csgo"; // CS2 в PandaScore живёт под slug "csgo"
const PAST_PAGES = 15;     // 15 × 100 = до 1500 прошедших матчей для обучения рейтинга
const UPCOMING_PAGES = 2;  // до 200 ближайших матчей
const OUT = new URL("../data/matches.json", import.meta.url);

// ---------- модель ----------
const START_BY_TIER = { s: 1650, a: 1600, b: 1550, c: 1500, d: 1450 };
const START_DEFAULT = 1450;
const K_BASE = 32;
const K_TIER = { s: 1.2, a: 1.1, b: 1, c: 0.9, d: 0.8 };
const MIN_GAMES = 5;       // меньше матчей — прогноз помечается как ненадёжный

// Шанс выиграть одну игру по разнице рейтингов
export const gameProb = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

// Шанс выиграть серию best-of-n, если шанс выиграть карту p
export function seriesProb(p, n) {
  if (!n || n < 2 || n % 2 === 0) return p; // BO1 и BO2 — как одна игра
  const need = (n + 1) / 2;
  let total = 0, c = 1; // c = C(need-1+i, i)
  for (let i = 0; i < need; i++) {
    if (i > 0) c = (c * (need - 1 + i)) / i;
    total += c * Math.pow(p, need) * Math.pow(1 - p, i);
  }
  return total;
}

export function buildRatings(pastMatches) {
  const teams = new Map();
  const preMatch = new Map(); // id матча -> шанс первой команды до матча
  const team = (o, tier) => {
    if (!teams.has(o.id)) {
      teams.set(o.id, {
        id: o.id, name: o.name, acronym: o.acronym, image: o.image_url,
        rating: START_BY_TIER[tier] ?? START_DEFAULT, games: 0, wins: 0, last: null
      });
    }
    return teams.get(o.id);
  };

  const sorted = [...pastMatches]
    .filter(m => m.winner_id && m.opponents?.length === 2 && !m.forfeit && m.begin_at)
    .sort((a, b) => new Date(a.begin_at) - new Date(b.begin_at));

  for (const m of sorted) {
    const tier = m.tournament?.tier;
    const A = team(m.opponents[0].opponent, tier);
    const B = team(m.opponents[1].opponent, tier);
    const bo = m.number_of_games || 1;
    const pa = seriesProb(gameProb(A.rating, B.rating), bo);
    preMatch.set(m.id, { pa, low: A.games < MIN_GAMES || B.games < MIN_GAMES });

    const aWon = m.winner_id === A.id ? 1 : 0;
    // разгром (2:0, 3:0) двигает рейтинг сильнее
    const sc = (m.results || []).map(r => r.score);
    const margin = sc.length === 2 && Math.abs(sc[0] - sc[1]) >= 2 && bo >= 3 ? 1.2 : 1;
    const kTier = K_TIER[tier] ?? 1;
    const kA = K_BASE * kTier * margin * (A.games < 10 ? 1.5 : 1);
    const kB = K_BASE * kTier * margin * (B.games < 10 ? 1.5 : 1);
    A.rating += kA * (aWon - pa);
    B.rating += kB * ((1 - aWon) - (1 - pa));
    A.games++; B.games++;
    if (aWon) A.wins++; else B.wins++;
    A.last = B.last = m.begin_at;
  }
  return { teams, preMatch };
}

// ---------- API ----------
async function get(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`PandaScore ${r.status} на ${url.pathname}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function pages(path, n, params) {
  const all = [];
  for (let page = 1; page <= n; page++) {
    const batch = await get(path, { ...params, per_page: 100, page });
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// ---------- сборка файла для сайта ----------
const slimTeam = (o, teams) => {
  if (!o) return null;
  const t = teams.get(o.id);
  return {
    id: o.id, name: o.name, acronym: o.acronym || null, image: o.image_url || null,
    rating: t ? Math.round(t.rating) : null, games: t ? t.games : 0
  };
};

function slimMatch(m, teams, preMatch) {
  const opp = (m.opponents || []).map(x => x.opponent);
  const [a, b] = [slimTeam(opp[0], teams), slimTeam(opp[1], teams)];
  const bo = m.number_of_games || 1;
  let prob = null, lowData = false;

  if (m.status === "finished" && preMatch.has(m.id)) {
    const pm = preMatch.get(m.id);
    prob = [pm.pa, 1 - pm.pa]; lowData = pm.low;
  } else if (a && b) {
    const ta = teams.get(a.id), tb = teams.get(b.id);
    const ra = ta?.rating ?? START_BY_TIER[m.tournament?.tier] ?? START_DEFAULT;
    const rb = tb?.rating ?? START_BY_TIER[m.tournament?.tier] ?? START_DEFAULT;
    const pa = seriesProb(gameProb(ra, rb), bo);
    prob = [pa, 1 - pa];
    lowData = (ta?.games ?? 0) < MIN_GAMES || (tb?.games ?? 0) < MIN_GAMES;
  }

  const score = a && b && m.results?.length
    ? [a.id, b.id].map(id => m.results.find(r => r.team_id === id)?.score ?? 0)
    : null;
  const stream = (m.streams_list || []).find(s => s.main) || (m.streams_list || [])[0];

  return {
    id: m.id,
    begin: m.begin_at || m.scheduled_at,
    status: m.status,
    bo,
    teams: [a, b],
    prob: prob && prob.map(x => Math.round(x * 1000) / 1000),
    lowData,
    score,
    winner: m.winner_id || null,
    league: m.league?.name || null,
    leagueImage: m.league?.image_url || null,
    tournament: [m.serie?.full_name, m.tournament?.name].filter(Boolean).join(" · ") || null,
    tier: m.tournament?.tier || null,
    stream: stream?.raw_url || null
  };
}

export async function main() {
  if (!TOKEN) {
    console.error("::error::Нет PANDASCORE_TOKEN. Добавьте его в Settings → Secrets and variables → Actions.");
    process.exit(1);
  }

  const [past, upcoming, running] = await Promise.all([
    pages("/matches/past", PAST_PAGES, { sort: "-begin_at" }),
    pages("/matches/upcoming", UPCOMING_PAGES, { sort: "begin_at" }),
    get("/matches/running", { per_page: 100 })
  ]);
  console.log(`Загружено: прошедших ${past.length}, ближайших ${upcoming.length}, идущих ${running.length}`);

  const { teams, preMatch } = buildRatings(past);

  // Точность модели на последних 200 матчах с достаточной историей
  const recent = past
    .filter(m => m.winner_id && preMatch.has(m.id) && !preMatch.get(m.id).low)
    .slice(0, 200);
  const hits = recent.filter(m => {
    const pa = preMatch.get(m.id).pa;
    const fav = pa >= 0.5 ? m.opponents[0].opponent.id : m.opponents[1].opponent.id;
    return fav === m.winner_id;
  }).length;

  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const ranking = [...teams.values()]
    .filter(t => t.games >= 8 && t.last && new Date(t.last).getTime() > cutoff)
    .sort((x, y) => y.rating - x.rating)
    .slice(0, 30)
    .map(t => ({ id: t.id, name: t.name, acronym: t.acronym, image: t.image,
                 rating: Math.round(t.rating), games: t.games, wins: t.wins }));

  const data = {
    updated: new Date().toISOString(),
    accuracy: recent.length ? { hits, total: recent.length } : null,
    running: running.map(m => slimMatch(m, teams, preMatch)),
    upcoming: upcoming.map(m => slimMatch(m, teams, preMatch)),
    past: past.filter(m => m.winner_id).slice(0, 60).map(m => slimMatch(m, teams, preMatch)),
    ranking
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  console.log(`Готово: ${ranking.length} команд в рейтинге, точность ${hits}/${recent.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error("::error::" + e.message.replace(/\n/g, " ")); process.exit(1); });
}
