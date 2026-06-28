#!/usr/bin/env node
/**
 * Server-side snapshot of Iran's Round-of-32 odds — runs on GitHub Actions (cron)
 * so the published data.json stays fresh even when nobody's computer is on.
 * Mirrors the live page's model: live ESPN group tables → best-third race →
 * Monte-Carlo of the remaining matches → probability Iran finishes top-8.
 * Node 20+ (built-in fetch). No dependencies.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IRAN = process.env.TEAM || "Iran";
// Target tournament is auto-resolved each run (men's fifa.world or women's fifa.wwc, whichever WC is
// live/next) so the same Action keeps working for every future World Cup with no config changes.
// Force a specific one with LEAGUE=fifa.wwc SEASON=2027 if ever needed.
let LEAGUE = "fifa.world", SEASON = "2026", STAND, SCORE;
function setTarget(league, season) {
  LEAGUE = league; SEASON = String(season);
  STAND = `https://site.api.espn.com/apis/v2/sports/soccer/${LEAGUE}/standings?season=${SEASON}`;
  SCORE = d => `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard?dates=${d}`;
}
setTarget(LEAGUE, SEASON);
// candidate WC years around now: men's every 4y from 2026, women's every 4y from 2023
function cycleYears(base) { const y = new Date().getFullYear(), k = Math.round((y - base) / 4), out = [];
  for (let i = -1; i < 3; i++) { const s = base + (k + i) * 4; if (s >= 2023 && !out.includes(s)) out.push(s); } return out; }
async function probeTarget(league, season) {
  try {
    const j = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${season}0401-${season}0901`).then(r => r.json());
    const ds = (j.events || []).map(e => +new Date(e.date)).filter(Boolean); if (!ds.length) return null;
    const now = Date.now(), start = Math.min(...ds), end = Math.max(...ds);
    const live = (j.events || []).some(e => e.status?.type?.state === "in");
    const dist = now < start ? start - now : now > end ? now - end : 0;
    return { league, season, live, score: (live ? 9e15 : 0) + (1e13 - dist) + (league === "fifa.world" ? 1 : 0) };
  } catch { return null; }
}
async function resolveTarget() {
  if (process.env.LEAGUE && process.env.SEASON) return { league: process.env.LEAGUE, season: process.env.SEASON };
  const cands = [];
  for (const s of cycleYears(2026)) cands.push(["fifa.world", s]);
  for (const s of cycleYears(2023)) cands.push(["fifa.wwc", s]);
  const res = (await Promise.all(cands.map(([l, s]) => probeTarget(l, s)))).filter(Boolean).sort((a, b) => b.score - a.score);
  return res[0] ? { league: res[0].league, season: res[0].season } : { league: "fifa.world", season: "2026" };
}
const SLOTS = 8, SIMS = 80000;
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

const pois = l => { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; };

function parseStandings(j) {
  const groups = [];
  (function walk(n) {
    if (!n) return;
    if (n.standings && n.standings.entries) {
      const teams = n.standings.entries.map(e => {
        const s = {}; (e.stats || []).forEach(x => s[x.name] = x.value);
        return { team: e.team.displayName, P: s.gamesPlayed | 0, pts: s.points | 0, gd: s.pointDifferential | 0, gf: s.pointsFor | 0 };
      });
      groups.push({ group: n.name, teams });
    }
    (n.children || []).forEach(walk); (n.groups || []).forEach(walk);
  })(j);
  return groups;
}
function parseScore(j) {
  return (j.events || []).map(e => {
    const c = e.competitions[0], st = e.status, cs = c.competitors;
    const home = cs.find(x => x.homeAway === "home") || cs[0], away = cs.find(x => x.homeAway === "away") || cs[1];
    return {
      home: home.team.displayName, away: away.team.displayName, date: e.date,
      hs: +home.score || 0, as: +away.score || 0, state: st.type.state,
      min: st.type.state === "in" ? (st.period >= 2 ? 45 + (parseInt(st.displayClock) || 0) : (parseInt(st.displayClock) || 0)) : (st.type.state === "post" ? 90 : 0),
    };
  });
}
const rankTeams = ts => ts.slice().sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
const thirdOf = g => rankTeams(g.teams)[2];
const aboveIran = (t, ir) => (t.pts > ir.pts) || (t.pts === ir.pts && t.gd > ir.gd) || (t.pts === ir.pts && t.gd === ir.gd && t.gf > ir.gf);

function compute(groups, matches) {
  const iran = groups.flatMap(g => g.teams).find(t => t.team === IRAN);
  // Iran not in this tournament (e.g. the Women's WC) → nothing to qualify; run as a title tracker only.
  if (!iran) return { noIran: true, iran: null, iranPos: 0, pending: [], baseAbove: 0, clinched: false, eliminated: true, pct: 0, allFinal: true };
  const teamGroup = {}; groups.forEach(g => g.teams.forEach(t => teamGroup[t.team] = g.group));
  // A group is final only when its matches have actually ended. ESPN bumps gamesPlayed (and
  // provisional points) the moment a match kicks off, so judging "done" on P>=3 alone would mark a
  // still-live group final at half-time and snap the odds to 100/0 prematurely. Keep any group with
  // a live match pending so the Monte-Carlo simulates its remaining minutes. (Mirrors the page.)
  // only a live GROUP-STAGE match counts (both teams in the same group); knockout games are inter-group
  const liveGroups = new Set(); matches.forEach(m => { if (m.state === "in") { const gh = teamGroup[m.home], ga = teamGroup[m.away]; if (gh && gh === ga) liveGroups.add(gh); } });
  const groupDone = g => g.teams.every(x => x.P >= 3) && !liveGroups.has(g.group);
  const pendGroups = new Set(groups.filter(g => !groupDone(g)).map(g => g.group));
  const matchByGroup = {}; matches.forEach(m => { const gp = teamGroup[m.home]; if (gp) (matchByGroup[gp] = matchByGroup[gp] || []).push(m); });
  const strength = {}; groups.forEach(g => g.teams.forEach(t => { const p = Math.max(1, t.P); strength[t.team] = t.pts / p + 0.3 * t.gd / p; }));

  const thirds = groups.map(g => ({ group: g.group, t: thirdOf(g), done: groupDone(g) }));
  const ranked = thirds.slice().sort((a, b) => b.t.pts - a.t.pts || b.t.gd - a.t.gd || b.t.gf - a.t.gf);
  const iranPos = ranked.findIndex(r => r.t.team === IRAN) + 1;
  const pending = thirds.filter(r => !r.done).map(r => r.group);

  const ip = iran.pts, igd = iran.gd, igf = iran.gf;
  const PG = pending.map(gp => {
    const ts = groups.find(x => x.group === gp).teams, n = ts.length, idx = {};
    ts.forEach((t, i) => idx[t.team] = i);
    const nf = [];
    for (const m of (matchByGroup[gp] || [])) if (m.state !== "post") {
      const hi = idx[m.home], ai = idx[m.away]; if (hi == null || ai == null) continue;
      const left = Math.max(0, (90 - m.min)) / 90, sh = strength[m.home] || 1, sa = strength[m.away] || 1;
      nf.push({ hi, ai, hs: m.hs, as: m.as,
        lh: 1.35 * left * Math.min(1.8, Math.max(.55, Math.exp(0.18 * (sh - sa)))),
        la: 1.35 * left * Math.min(1.8, Math.max(.55, Math.exp(0.18 * (sa - sh)))) });
    }
    return { n, bp: ts.map(t => t.pts), bgd: ts.map(t => t.gd), bgf: ts.map(t => t.gf),
      P: new Array(n), GD: new Array(n), GF: new Array(n), ord: ts.map((_, i) => i), nf };
  });
  const baseAbove = thirds.filter(r => r.done && r.t.team !== IRAN && aboveIran(r.t, iran)).length;

  let advance = 0;
  if (!PG.length) { advance = baseAbove < SLOTS ? SIMS : 0; }
  else for (let s = 0; s < SIMS; s++) {
    let above = baseAbove;
    for (let gi = 0; gi < PG.length; gi++) {
      const G = PG[gi], n = G.n, P = G.P, GD = G.GD, GF = G.GF;
      for (let i = 0; i < n; i++) { P[i] = G.bp[i]; GD[i] = G.bgd[i]; GF[i] = G.bgf[i]; }
      for (let k = 0; k < G.nf.length; k++) {
        const m = G.nf[k], gh = m.hs + pois(m.lh), ga = m.as + pois(m.la);
        GF[m.hi] += gh; GD[m.hi] += gh - ga; GF[m.ai] += ga; GD[m.ai] += ga - gh;
        if (gh > ga) P[m.hi] += 3; else if (gh < ga) P[m.ai] += 3; else { P[m.hi]++; P[m.ai]++; }
      }
      const o = G.ord; o.sort((a, b) => P[b] - P[a] || GD[b] - GD[a] || GF[b] - GF[a]);
      const ti = o[2];
      if (P[ti] > ip || (P[ti] === ip && GD[ti] > igd) || (P[ti] === ip && GD[ti] === igd && GF[ti] > igf)) above++;
    }
    if (above < SLOTS) advance++;
  }
  const clinched = baseAbove + pending.length <= SLOTS - 1;   // top-8 guaranteed even in the worst case
  const eliminated = baseAbove >= SLOTS;                       // already 8 thirds above Iran
  return { iran, iranPos, pending, baseAbove, clinched, eliminated, pct: advance / SIMS * 100, allFinal: pending.length === 0 };
}
// match the page: temper the over-confident model toward betting-market consensus, snap to 100/0 when decided
const CAL_SHRINK = 0.45;
function displayPct(R) {
  if (R.clinched) return 100; if (R.eliminated) return 0;
  const p = R.pct; if (p >= 100) return 100; if (p <= 0) return 0;
  const x = p / 100; return 100 / (1 + Math.exp(-CAL_SHRINK * Math.log(x / (1 - x))));
}

async function findNext() {
  try {
    const j = await fetch(SCORE(`${SEASON}0601-${SEASON}0815`)).then(r => r.json());
    const evs = (j.events || []).map(e => {
      const c = e.competitions[0];
      return { date: e.date, venue: (c.venue && c.venue.fullName) || "", state: e.status.type.state,
        teams: c.competitors.map(x => x.team.displayName) };
    });
    let m = evs.find(e => e.teams.some(t => /^iran$/i.test(t))); const confirmed = !!m;
    if (!m) m = evs.find(e => e.teams.some(t => /^third place group/i.test(t) &&
      t.replace(/^third place group /i, "").split("/").map(s => s.trim()).includes("G")));
    if (!m) return null;
    const opp = m.teams.find(t => !/^iran$/i.test(t)) || "TBD";
    return { opponent: opp, kickoff: m.date, venue: m.venue, confirmed };
  } catch { return null; }
}

// Most-likely World Cup winner via a bracket Monte-Carlo over the actual R32 pairings.
// Ratings come from group-stage form; later rounds pair winners in bracket order (an
// estimate). Returns null until the R32 field is concrete (i.e. the group stage is done).
// Pre-tournament strength prior (~ FIFA ranking / market tiers, 0–100). Blended with
// group-stage form so a strong team that merely coasted through groups stays a favorite.
const PRIOR = {
  "Spain":96,"Argentina":95,"France":95,"England":92,"Brazil":91,"Portugal":90,"Netherlands":87,
  "Germany":86,"Belgium":84,"Croatia":80,"Morocco":81,"Uruguay":80,"Colombia":79,"Japan":78,
  "Senegal":78,"Norway":78,"USA":77,"United States":77,"Switzerland":77,"Türkiye":76,"Turkey":76,
  "Mexico":75,"Ecuador":75,"Austria":75,"Sweden":74,"Czechia":74,"Ivory Coast":74,"Canada":73,
  "Paraguay":73,"Iran":73,"Scotland":72,"Bosnia-Herzegovina":72,"Egypt":72,"Algeria":72,"Korea Republic":71,
  "South Korea":71,"Australia":71,"Ghana":70,"Tunisia":70,"Congo DR":68,"Qatar":66,"Saudi Arabia":66,
  "Uzbekistan":66,"Panama":66,"South Africa":66,"Jordan":64,"Iraq":64,"Cape Verde":63,"New Zealand":62,
  "Curaçao":60,"Haiti":58,
};
function teamRatings(groups) {
  const r = {};
  groups.forEach(g => g.teams.forEach(t => {
    const p = Math.max(1, t.P);
    const form = 50 + 11 * (t.pts / p - 1.5) + 7 * (t.gd / p);   // group-stage form, ~30–80
    const prior = PRIOR[t.team] ?? 65;
    r[t.team] = 0.65 * prior + 0.35 * form;                       // 0–100 scale
  }));
  return r;
}
async function computeFavorite(groups) {
  let j; try { j = await fetch(SCORE(`${SEASON}0601-${SEASON}0815`)).then(r => r.json()); } catch { return null; }
  const ph = t => /third place|winner|group/i.test(t);
  const pairs = (j.events || [])
    .map(e => ({ date: e.date, teams: e.competitions[0].competitors.map(x => x.team.displayName) }))
    .filter(e => e.teams.length === 2 && e.teams.every(t => !ph(t)))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(e => e.teams.slice());
  if (pairs.length < 16) return null;                 // R32 not fully set yet
  const first = pairs.slice(0, 16);
  const rt = teamRatings(groups), K = 0.055, rg = t => (rt[t] ?? 65);   // ratings on a 0–100 scale
  const pWin = (a, b) => 1 / (1 + Math.exp(-K * (rg(a) - rg(b))));
  const N = 20000, wins = {};
  for (let s = 0; s < N; s++) {
    let cur = first;
    for (;;) {
      const w = cur.map(([a, b]) => (Math.random() < pWin(a, b) ? a : b));
      if (w.length === 1) { wins[w[0]] = (wins[w[0]] || 0) + 1; break; }
      const nx = []; for (let i = 0; i < w.length; i += 2) nx.push([w[i], w[i + 1]]);
      cur = nx;
    }
  }
  const champ = {}; for (const t in wins) champ[t] = wins[t] / N;   // model championship distribution
  let fav = null, fc = -1; for (const t in wins) if (wins[t] > fc) { fc = wins[t]; fav = t; }
  return fav ? { champ, favorite: fav, favorite_pct: Math.round(fc / N * 100) } : null;
}

const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
// Live World Cup-winner odds from Kalshi's public API (de-vigged to a probability per team)
async function fetchWinnerMarket() {
  try {
    const j = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMENWORLDCUP&limit=100",
      { headers: { "User-Agent": "Mozilla/5.0" } }).then(r => r.json());
    const m = {};
    for (const k of (j.markets || [])) {
      const name = k.yes_sub_title || k.subtitle || "";
      const lp = parseFloat(k.last_price_dollars), yb = parseFloat(k.yes_bid_dollars), ya = parseFloat(k.yes_ask_dollars);
      const p = lp || ((yb && ya) ? (yb + ya) / 2 : 0);
      if (name && p > 0) m[norm(name)] = p;
    }
    const s = Object.values(m).reduce((a, b) => a + b, 0);
    if (s > 0) for (const k in m) m[k] /= s;
    return Object.keys(m).length ? m : null;
  } catch { return null; }
}
// Blend the model's championship distribution with the betting market (60% market / 40% model).
// Returns the favorite plus the full ranked `contenders` table (every team with model+market+blended %).
function blendFavorite(favModel, market) {
  if (!favModel) return null;
  const model = favModel.champ;
  // blended distribution per team (falls back to pure model when no market data)
  const blended = {};
  if (market) {
    for (const t in model) blended[t] = 0.4 * model[t] + 0.6 * (market[norm(t)] || 0);
    const s = Object.values(blended).reduce((a, b) => a + b, 0); if (s > 0) for (const t in blended) blended[t] /= s;
  } else {
    for (const t in model) blended[t] = model[t];
  }
  let bf = null, bp = -1; for (const t in blended) if (blended[t] > bp) { bp = blended[t]; bf = t; }
  // full leaderboard, strongest first — drives the "title odds" table on the page
  const contenders = Object.keys(blended)
    .map(t => ({ team: t,
      pct: Math.round(blended[t] * 100),
      pct_model: Math.round((model[t] || 0) * 100),
      pct_market: market ? Math.round((market[norm(t)] || 0) * 100) : null }))
    .sort((a, b) => blended[b.team] - blended[a.team])
    .filter((c, i) => i < 12 || c.pct >= 1);
  return { favorite: bf, favorite_pct: Math.round(bp * 100),
    favorite_pct_model: Math.round((model[bf] || 0) * 100),
    favorite_pct_market: market ? Math.round((market[norm(bf)] || 0) * 100) : null,
    contenders };
}

async function main() {
  // pick whichever World Cup is live/next (men's or women's, any season) before fetching
  const tgt = await resolveTarget(); setTarget(tgt.league, tgt.season);

  // rolling activity window — also covers the last group day's matches for the sim
  const win = `${ymd(new Date(Date.now() - 2 * 864e5))}-${ymd(new Date(Date.now() + 5 * 864e5))}`;
  let stJ, sbJ;
  try {
    [stJ, sbJ] = await Promise.all([fetch(STAND).then(r => r.json()), fetch(SCORE(win)).then(r => r.json())]);
  } catch (e) {
    console.error("fetch failed (transient):", e.message);   // keep last good data.json; fail the run so it's visible
    process.exit(1);
  }
  const groups = parseStandings(stJ);
  const events = sbJ.events || [];
  const hasTeam = groups.flatMap(g => g.teams).some(t => t.team === IRAN);
  const liveOrSoon = events.some(e => { const s = e.status?.type?.state; return s === "in" || s === "pre"; });

  // Idle-gate: between tournaments (or if ESPN's shape changes) there's nothing to do — exit
  // WITHOUT writing so no commit happens and the Action quietly self-quiesces. data.json is left
  // intact. NOTE: Iran's absence is NOT idle — the Women's WC still gets tracked as a title race.
  if (!groups.length || (!liveOrSoon && events.length === 0)) {
    console.log(`idle — no active ${LEAGUE} ${SEASON} (groups=${groups.length}, events=${events.length}); leaving data.json unchanged.`);
    return;
  }

  const matches = parseScore(sbJ);
  const R = compute(groups, matches);
  const next = (R.noIran || (R.allFinal && R.pct < 50)) ? null : await findNext();
  const status = R.noIran ? "absent"
    : R.clinched ? "advanced" : R.eliminated ? "eliminated"
    : R.allFinal ? (R.pct >= 50 ? "advanced" : "eliminated") : "live";
  const shown = R.noIran ? null : Math.round(displayPct(R));   // calibrated, snaps to 100/0 when clinched/eliminated
  // Kalshi's winner market is men's-only (KXMENWORLDCUP); for the Women's WC fall back to model-only
  const [favModel, market] = await Promise.all([computeFavorite(groups), LEAGUE === "fifa.world" ? fetchWinnerMarket() : null]);
  const fav = blendFavorite(favModel, market);   // WC winner: model blended with market (null until R32 set)

  const prev = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
  const out = {
    ...prev,
    updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    server_updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    league: LEAGUE, season: SEASON, team: IRAN, team_in_field: hasTeam,
    iran_pct: shown,
    baseline_pct: shown,
    iran_pct_raw: R.noIran ? null : Math.round(R.pct),
    iran_pos: R.noIran ? null : R.iranPos,
    locked_above: R.baseAbove,
    pending_groups: R.pending.map(g => g.replace("Group ", "")),
    iran_status: status,
    next_opponent: next ? next.opponent : null,
    next_kickoff: next ? next.kickoff : null,
    next_confirmed: next ? next.confirmed : null,
    favorite: fav ? fav.favorite : null,
    favorite_pct: fav ? fav.favorite_pct : null,
    favorite_pct_model: fav ? fav.favorite_pct_model : null,
    favorite_pct_market: fav ? fav.favorite_pct_market : null,
    contenders: fav ? fav.contenders : null,
    live: true,
    source: "ESPN public feed (standings + scoreboard); recomputed server-side by scripts/snapshot.mjs",
  };
  writeFileSync(join(ROOT, "data.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`${LEAGUE} ${SEASON} · ${IRAN} ${R.noIran ? "not in field" : R.pct.toFixed(1) + "% (pos " + R.iranPos + ")"} · status=${status}`
    + (next ? ` · next: ${next.opponent}${next.confirmed ? " (confirmed)" : " (projected)"}` : "")
    + (fav ? ` · WC favorite: ${fav.favorite} ${fav.favorite_pct}%` : " · favorite: TBD (R32 not set)"));
}
main().catch(e => { console.error(e); process.exit(1); });
