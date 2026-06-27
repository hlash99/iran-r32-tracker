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
const STAND = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026";
const SCORE = d => `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${d}`;
const IRAN = "Iran", SLOTS = 8, SIMS = 80000;

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
  if (!iran) throw new Error("Iran not in feed");
  const teamGroup = {}; groups.forEach(g => g.teams.forEach(t => teamGroup[t.team] = g.group));
  const pendGroups = new Set(groups.filter(g => g.teams.some(t => t.P < 3)).map(g => g.group));
  const matchByGroup = {}; matches.forEach(m => { const gp = teamGroup[m.home]; if (gp) (matchByGroup[gp] = matchByGroup[gp] || []).push(m); });
  const strength = {}; groups.forEach(g => g.teams.forEach(t => { const p = Math.max(1, t.P); strength[t.team] = t.pts / p + 0.3 * t.gd / p; }));

  const thirds = groups.map(g => ({ group: g.group, t: thirdOf(g), done: g.teams.every(x => x.P >= 3) }));
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
  return { iran, iranPos, pending, baseAbove, pct: advance / SIMS * 100, allFinal: pending.length === 0 };
}

async function findNext() {
  try {
    const j = await fetch(SCORE("20260628-20260704")).then(r => r.json());
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

async function main() {
  const [stJ, ...scs] = await Promise.all([
    fetch(STAND).then(r => r.json()),
    ...["20260626", "20260627", "20260628"].map(d => fetch(SCORE(d)).then(r => r.json()).catch(() => ({}))),
  ]);
  const groups = parseStandings(stJ);
  const matches = scs.flatMap(parseScore);
  const R = compute(groups, matches);
  const next = R.allFinal && R.pct < 50 ? null : await findNext();
  const status = R.allFinal ? (R.pct >= 50 ? "advanced" : "eliminated") : "live";

  const prev = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
  const out = {
    ...prev,
    updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    server_updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    iran_pct: Math.round(R.pct),
    baseline_pct: Math.round(R.pct),
    iran_pos: R.iranPos,
    locked_above: R.baseAbove,
    pending_groups: R.pending.map(g => g.replace("Group ", "")),
    iran_status: status,
    next_opponent: next ? next.opponent : null,
    next_kickoff: next ? next.kickoff : null,
    next_confirmed: next ? next.confirmed : null,
    live: true,
    source: "ESPN public feed (standings + scoreboard); recomputed server-side by scripts/snapshot.mjs",
  };
  writeFileSync(join(ROOT, "data.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`Iran ${R.pct.toFixed(1)}% (pos ${R.iranPos}, ${R.pending.length} groups live, status=${status})`
    + (next ? ` · next: ${next.opponent}${next.confirmed ? " (confirmed)" : " (projected)"}` : ""));
}
main().catch(e => { console.error(e); process.exit(1); });
