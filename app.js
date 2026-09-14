(() => {
  "use strict";

  const STORAGE_KEY = "df-matchboard-v1";
  const METRICS = ["score", "kills", "deaths", "assists", "revives", "engineering", "captures", "spawns"];
  const LABELS = {
    score: "Score", kills: "Kills", deaths: "Deaths", assists: "Assists",
    revives: "Revives", engineering: "Engineering", captures: "Captures", spawns: "Spawns"
  };
  const app = document.querySelector("#app");
  const imageDialog = document.querySelector("#image-dialog");
  const dialogImage = document.querySelector("#dialog-image");
  const dialogTitle = document.querySelector("#dialog-title");
  let matches = loadMatches();
  let sortKey = "score";
  let sortDirection = -1;
  let filterText = "";
  let pendingScreenshot = "";
  let toastTimer;
  let splitState = {
    image: "",
    namesText: "",
    groupsText: "",
    unreadableSlots: [],
    progress: 0,
    status: "Upload a lobby screenshot to extract the visible names.",
    result: null,
    selected: { GTI: "", HAAVK: "" }
  };

  function cloneSeed() {
    return JSON.parse(JSON.stringify(window.SEED_MATCHES));
  }

  function loadMatches() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : cloneSeed();
    } catch (error) {
      console.warn("Could not read saved data", error);
      return cloneSeed();
    }
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(matches));
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }

  function fmt(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function displayDate(value) {
    const [date, time = ""] = value.split("T");
    const [year, month, day] = date.split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${Number(day)} ${months[Number(month) - 1]} ${year}${time ? ` · ${time}` : ""}`;
  }

  function route() {
    const raw = location.hash.replace(/^#/, "") || "leaderboard";
    const [name, ...rest] = raw.split("/");
    return { name, value: decodeURIComponent(rest.join("/")) };
  }

  function setActiveNav(name) {
    const base = name === "match" ? "matches" : name === "player" ? "players" : name;
    document.querySelectorAll("[data-route-link]").forEach(link => {
      link.classList.toggle("active", link.dataset.routeLink === base);
    });
  }

  function aggregatePlayers() {
    const players = new Map();
    matches.forEach(match => {
      Object.entries(match.teams).forEach(([team, rows]) => {
        rows.forEach(data => {
          if (!players.has(data.name)) {
            players.set(data.name, {
              name: data.name, matches: 0, wins: 0,
              score: 0, kills: 0, deaths: 0, assists: 0,
              revives: 0, engineering: 0, captures: 0, spawns: 0
            });
          }
          const player = players.get(data.name);
          player.matches += 1;
          if (match.winner === team) player.wins += 1;
          METRICS.forEach(metric => player[metric] += Number(data[metric] || 0));
        });
      });
    });
    return [...players.values()].map(player => ({
      ...player,
      avgScore: player.matches ? Math.round(player.score / player.matches) : 0,
      kd: player.deaths ? player.kills / player.deaths : player.kills,
      winRate: player.matches ? player.wins / player.matches : 0
    }));
  }

  function median(values) {
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function normalizeIdentity(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase()
      .replace(/[|｜•·・—–\-_\s]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function levenshtein(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const old = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = old;
      }
    }
    return previous[b.length];
  }

  function balanceProfiles() {
    const profiles = new Map();
    const roleMetrics = ["kills", "assists", "revives", "engineering", "captures", "spawns"];
    matches.forEach(match => {
      const rows = Object.values(match.teams).flat();
      const scoreMedian = median(rows.map(data => data.score));
      const roleMeans = Object.fromEntries(roleMetrics.map(metric => [metric, Math.max(1, rows.reduce((sum, data) => sum + data[metric], 0) / rows.length)]));
      rows.forEach(data => {
        if (!profiles.has(data.name)) profiles.set(data.name, { name: data.name, history: 0, samples: 0, indexTotal: 0, roleTotals: Object.fromEntries(roleMetrics.map(metric => [metric, 0])) });
        const profile = profiles.get(data.name);
        profile.history += 1;
        if (data.score < scoreMedian * .25) return;
        profile.samples += 1;
        profile.indexTotal += Math.max(50, Math.min(175, data.score / scoreMedian * 100));
        roleMetrics.forEach(metric => profile.roleTotals[metric] += Math.min(3, data[metric] / roleMeans[metric]));
      });
    });
    return [...profiles.values()].map(profile => {
      const observed = profile.samples ? profile.indexTotal / profile.samples : 100;
      const reliability = profile.samples / (profile.samples + 3);
      return {
        ...profile,
        rating: profile.samples ? 100 + reliability * (observed - 100) : null,
        reliability,
        roles: Object.fromEntries(Object.entries(profile.roleTotals).map(([metric, value]) => [metric, profile.samples ? value / profile.samples : 1]))
      };
    });
  }

  function resolvePlayerName(input) {
    const profiles = balanceProfiles();
    const normalized = normalizeIdentity(input);
    const exact = profiles.find(profile => normalizeIdentity(profile.name) === normalized);
    if (exact) return { input, name: exact.name, profile: exact, confidence: 1, fuzzy: false };
    if (normalized.length < 4) return { input, name: input, profile: null, confidence: 0, fuzzy: false };
    let best = null;
    profiles.forEach(profile => {
      const candidate = normalizeIdentity(profile.name);
      if (candidate.length < 4) return;
      const distance = levenshtein(normalized, candidate);
      let confidence = 1 - distance / Math.max(normalized.length, candidate.length);
      if (normalized.includes(candidate) || candidate.includes(normalized)) confidence = Math.max(confidence, Math.min(normalized.length, candidate.length) / Math.max(normalized.length, candidate.length));
      if (!best || confidence > best.confidence) best = { input, name: profile.name, profile, confidence, fuzzy: true };
    });
    return best?.confidence >= .72 ? best : { input, name: input, profile: null, confidence: best?.confidence || 0, fuzzy: false };
  }

  function attendanceNames() {
    const seen = new Set();
    const correctedSlots = splitState.unreadableSlots.map(slot => slot.name || "");
    return [...splitState.namesText.split(/\r?\n/), ...correctedSlots].map(name => name.trim()).filter(name => {
      const key = normalizeIdentity(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function leaderboardRows() {
    return aggregatePlayers()
      .filter(player => player.name.toLocaleLowerCase().includes(filterText.toLocaleLowerCase()))
      .sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (typeof av === "string") return av.localeCompare(bv) * sortDirection;
        return (av - bv || a.name.localeCompare(b.name)) * sortDirection;
      });
  }

  function pageHead(eyebrow, title, description, actions = "") {
    return `<section class="page-head">
      <div><div class="eyebrow">${escapeHTML(eyebrow)}</div><h1>${escapeHTML(title)}</h1><p class="lede">${escapeHTML(description)}</p></div>
      ${actions ? `<div class="toolbar">${actions}</div>` : ""}
    </section>`;
  }

  function leaderboardTable(players) {
    if (!players.length) return `<div class="empty">No players match this search.</div>`;
    const columns = [
      ["name", "Player"], ["matches", "Matches"], ["wins", "Wins"], ["winRate", "Win %"],
      ["score", "Score"], ["avgScore", "Avg score"], ["kills", "Kills"], ["deaths", "Deaths"],
      ["kd", "K/D"], ["assists", "Assists"], ["revives", "Revives"], ["engineering", "Engineering"],
      ["captures", "Captures"], ["spawns", "Spawn on"]
    ];
    return `<div class="table-shell"><table aria-label="Cumulative player leaderboard">
      <thead><tr><th>#</th>${columns.map(([key, label]) => `<th data-sort="${key}">${label}${sortKey === key ? (sortDirection < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
      <tbody>${players.map((player, index) => `<tr>
        <td class="${index < 3 ? "rank-top" : ""}">${index + 1}</td>
        <td><button class="player-link" data-player="${escapeHTML(player.name)}">${escapeHTML(player.name)}</button></td>
        <td>${player.matches}</td><td>${player.wins}</td><td>${(player.winRate * 100).toFixed(0)}%</td>
        <td>${fmt(player.score)}</td><td>${fmt(player.avgScore)}</td><td>${fmt(player.kills)}</td><td>${fmt(player.deaths)}</td>
        <td>${player.kd.toFixed(2)}</td><td>${fmt(player.assists)}</td><td>${fmt(player.revives)}</td>
        <td>${fmt(player.engineering)}</td><td>${fmt(player.captures)}</td><td>${fmt(player.spawns)}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function renderLeaderboard() {
    const players = leaderboardRows();
    const totalRows = matches.reduce((sum, match) => sum + match.teams.GTI.length + match.teams.HAAVK.length, 0);
    app.innerHTML = pageHead(
      "Career totals", "Leaderboard",
      "Every statistic is summed directly from the four supplied scoreboards. Click a player to inspect the source matches.",
      `<button class="button ghost" data-download-csv>Export CSV</button>`
    ) + `<section class="stats-strip">
      <div class="stat-card"><span>Recorded matches</span><strong>${matches.length}</strong></div>
      <div class="stat-card"><span>Unique players</span><strong>${aggregatePlayers().length}</strong></div>
      <div class="stat-card"><span>Scoreboard rows</span><strong>${totalRows}</strong></div>
      <div class="stat-card"><span>Total score</span><strong>${fmt(aggregatePlayers().reduce((sum, p) => sum + p.score, 0))}</strong></div>
    </section>
    <section class="toolbar"><input class="search" id="player-filter" type="search" placeholder="Search player name…" value="${escapeHTML(filterText)}" aria-label="Search player name"></section>
    ${leaderboardTable(players)}`;
  }

  function teamTotal(rows, metric = "score") {
    return rows.reduce((sum, data) => sum + Number(data[metric] || 0), 0);
  }

  function renderMatches() {
    const ordered = [...matches].sort((a, b) => b.playedAt.localeCompare(a.playedAt));
    app.innerHTML = pageHead(
      "Source archive", "Matches",
      "Each record preserves both teams, all eight statistics, and the original scoreboard screenshot.",
      `<a class="button primary" href="#import">Add match</a>`
    ) + `<section class="match-grid">${ordered.map(match => `
      <article class="match-card" data-match="${escapeHTML(match.id)}" tabindex="0">
        <div class="match-title-line"><h2>${escapeHTML(match.map)}</h2><span class="winner-chip">${escapeHTML(match.winner)} won</span></div>
        <div class="match-meta">${displayDate(match.playedAt)} · ${escapeHTML(match.mode)}</div>
        <div class="match-score">
          <div class="team-block"><span>GTI · ${match.teams.GTI.length} players</span><strong>${fmt(teamTotal(match.teams.GTI))}</strong></div>
          <div class="versus">VS</div>
          <div class="team-block"><span>HAAVK · ${match.teams.HAAVK.length} players</span><strong>${fmt(teamTotal(match.teams.HAAVK))}</strong></div>
        </div>
      </article>`).join("")}</section>`;
  }

  function scoreboardTable(rows, team) {
    const head = ["Score", "Kills", "Deaths", "Assists", "Revives", "Engineering", "Captures", "Spawn on"];
    return `<section class="scoreboard ${team.toLowerCase()}">
      <div class="scoreboard-head"><span class="team-chip ${team.toLowerCase()}">${team}</span><strong class="numeric">${fmt(teamTotal(rows))}</strong></div>
      <div class="table-shell"><table aria-label="${team} scoreboard"><thead><tr><th>#</th><th>Player</th>${head.map(item => `<th>${item}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((data, index) => `<tr><td>${index + 1}</td><td><button class="player-link" data-player="${escapeHTML(data.name)}">${escapeHTML(data.name)}</button></td>${METRICS.map(metric => `<td>${fmt(data[metric])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>`;
  }

  function renderMatch(id) {
    const match = matches.find(item => item.id === id);
    if (!match) return renderNotFound("Match not found");
    app.innerHTML = pageHead(
      match.mode, match.map,
      `${displayDate(match.playedAt)} · ${match.teams.GTI.length + match.teams.HAAVK.length} players`,
      `<span class="result-chip ${match.result.toLowerCase()}">${escapeHTML(match.result)}</span>
       <button class="button" data-view-image="${escapeHTML(match.id)}">View screenshot</button>
       <a class="button" href="#import/${encodeURIComponent(match.id)}">Edit data</a>
       <button class="button danger" data-delete-match="${escapeHTML(match.id)}">Delete</button>`
    ) + `<section class="scoreboards">${scoreboardTable(match.teams.GTI, "GTI")}${scoreboardTable(match.teams.HAAVK, "HAAVK")}</section>`;
  }

  function renderPlayers() {
    const players = leaderboardRows();
    app.innerHTML = pageHead("Player index", "Players", "Search every recorded identity and open a match-by-match history.") +
      `<section class="toolbar"><input class="search" id="player-filter" type="search" placeholder="Search player name…" value="${escapeHTML(filterText)}" aria-label="Search player name"></section>` +
      leaderboardTable(players);
  }

  function renderSplit() {
    const names = attendanceNames();
    app.innerHTML = pageHead(
      "Attendance → teams", "Split teams",
      "Upload the lobby roster, correct the extracted names, then balance only the players visible in occupied Squad A–E slots.",
      splitState.result ? `<button class="button" data-copy-teams>Copy teams</button>` : ""
    ) + `<section class="split-input-grid">
      <div class="panel">
        <h2>1. Lobby screenshot</h2>
        <label>Select screenshot<input id="attendance-image-input" type="file" accept="image/*"></label>
        <div class="attendance-preview" id="attendance-image-preview">${splitState.image ? `<img src="${splitState.image}" alt="Lobby attendance screenshot">` : "Only filled player slots under Squad A–E are read."}</div>
        <div class="ocr-progress" aria-hidden="true"><span id="ocr-progress-bar" style="--progress:${splitState.progress}%"></span></div>
        <p class="help" id="ocr-status">${escapeHTML(splitState.status)}</p>
      </div>
      <div class="panel">
        <h2>2. Review attendance</h2>
        <div class="form-grid" style="grid-template-columns:minmax(0,1fr) minmax(220px,.55fr)">
          <label>Player names<textarea id="attendance-names" spellcheck="false" placeholder="One player per line">${escapeHTML(splitState.namesText)}</textarea></label>
          <label>Keep-together preferences<textarea id="keep-groups" spellcheck="false" placeholder="Player one, Player two">${escapeHTML(splitState.groupsText)}</textarea></label>
        </div>
        <div id="unreadable-slots">${unreadableSlotsHTML()}</div>
        <p class="help">The room count, map, team headers, chat, and empty squad slots are ignored. One preferred group per line, with names separated by commas. With an odd number of visible players, attacking GTI receives the extra player.</p>
        <div class="toolbar"><button class="button primary" type="button" data-generate-split>Generate teams</button>${splitState.result ? `<button class="button" type="button" data-reroll-split>Reroll alternative</button>` : ""}</div>
      </div>
    </section>
    <section id="attendance-review">${attendanceReviewHTML(names)}</section>
    <section id="split-output">${splitResultHTML()}</section>
    <details class="panel balance-method"><summary>How the provisional balance rating works</summary>
      <p>Each known player's score is compared with the median score in the same match, so longer or higher-scoring matches do not dominate. Extremely low-score late joins are ignored, and ratings with only a few appearances are pulled toward the 100 baseline.</p>
      <p>The optimizer then checks overall rating plus kills, assists, revive, engineering, capture, and spawn contribution. Score is the main skill signal; the other columns help prevent one team receiving all players of the same style. Deaths remain visible in player history but are not rewarded as a role.</p>
    </details>`;
  }

  function attendanceReviewHTML(names = attendanceNames()) {
    if (!names.length && !splitState.unreadableSlots.length) return "";
    const resolved = names.map(resolvePlayerName);
    const unresolved = splitState.unreadableSlots.filter(slot => !slot.name.trim());
    return `<div class="panel" style="margin-top:16px">
      <div class="match-title-line"><h2 style="margin:0">Name check</h2><span class="mini-chip">${names.length} visible</span></div>
      ${unresolved.length ? `<p class="warning" style="margin-top:12px">${unresolved.length} occupied squad slot${unresolved.length === 1 ? "" : "s"} could not be read confidently. Enter ${unresolved.length === 1 ? "that name" : "those names"} above before generating teams.</p>` : `<p class="success-note" style="margin-top:12px">All detected occupied squad slots are ready for balancing.</p>`}
      <div class="review-list">${resolved.map(item => `<div class="review-player"><strong title="${escapeHTML(item.input)}">${escapeHTML(item.fuzzy ? `${item.input} → ${item.name}` : item.name)}</strong><span class="mini-chip ${item.profile?.rating ? "known" : "new"}">${item.profile?.rating ? `${item.profile.rating.toFixed(1)} · n${item.profile.samples}` : "random"}</span></div>`).join("")}</div>
    </div>`;
  }

  function unreadableSlotsHTML() {
    if (!splitState.unreadableSlots.length) return "";
    return `<section class="ocr-corrections"><h3>Names needing correction</h3><p class="help">These slots contain players, but the name reader was not confident enough to guess.</p><div class="correction-grid">${splitState.unreadableSlots.map((slot, index) => `<label>${escapeHTML(`${slot.team} · Squad ${slot.squad} · player ${slot.slot}`)}<input data-unreadable-slot="${index}" value="${escapeHTML(slot.name)}" placeholder="Enter the visible name"></label>`).join("")}</div></section>`;
  }

  function parseKeepGroups(players) {
    const byKey = new Map(players.map(player => [normalizeIdentity(player.name), player.name]));
    const missing = [];
    const groups = splitState.groupsText.split(/\r?\n/).map(line => line.split(",").map(name => name.trim()).filter(Boolean)).filter(group => group.length > 1).map(group => {
      const found = [];
      group.forEach(name => {
        const exact = byKey.get(normalizeIdentity(name));
        if (exact) found.push(exact);
        else missing.push(name);
      });
      return [...new Set(found)];
    }).filter(group => group.length > 1);
    return { groups, missing };
  }

  function prepareBalancePlayers(names) {
    const used = new Set();
    return names.map(resolvePlayerName).filter(item => {
      const key = normalizeIdentity(item.name);
      if (used.has(key)) return false;
      used.add(key);
      return true;
    }).map(item => ({
      name: item.name,
      sourceName: item.input,
      rating: item.profile?.rating ?? 100,
      samples: item.profile?.samples || 0,
      known: Boolean(item.profile?.rating),
      roles: item.profile?.roles || { kills: 1, assists: 1, revives: 1, engineering: 1, captures: 1, spawns: 1 },
      squad: ""
    }));
  }

  function shuffledIndexes(length) {
    const values = Array.from({ length }, (_, index) => index);
    for (let i = values.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  function assignmentCost(players, assignment, groups) {
    const sides = [[], []];
    players.forEach((player, index) => sides[assignment[index]].push(player));
    const skill = sides.map(side => side.reduce((sum, player) => sum + player.rating, 0));
    const skillGap = Math.abs(skill[0] - skill[1]) / Math.max(1, (skill[0] + skill[1]) / 2);
    const top = sides.map(side => [...side].sort((a, b) => b.rating - a.rating).slice(0, 5).reduce((sum, player) => sum + player.rating, 0));
    const topGap = Math.abs(top[0] - top[1]) / Math.max(1, (top[0] + top[1]) / 2);
    const roleMetrics = ["kills", "assists", "revives", "engineering", "captures", "spawns"];
    const roleGap = roleMetrics.reduce((total, metric) => {
      const values = sides.map(side => side.reduce((sum, player) => sum + player.roles[metric], 0));
      return total + Math.abs(values[0] - values[1]) / Math.max(1, (values[0] + values[1]) / 2);
    }, 0) / roleMetrics.length;
    const unknownGap = Math.abs(sides[0].filter(player => !player.known).length - sides[1].filter(player => !player.known).length);
    const sideByName = new Map(players.map((player, index) => [player.name, assignment[index]]));
    const splitGroups = groups.filter(group => new Set(group.map(name => sideByName.get(name))).size > 1).length;
    return skillGap * 1000 + topGap * 250 + roleGap * 50 + unknownGap * 3 + splitGroups * 7;
  }

  function optimizeTeams(players, groups) {
    const targetGTI = Math.ceil(players.length / 2);
    let best = null;
    for (let restart = 0; restart < 28; restart += 1) {
      const order = shuffledIndexes(players.length);
      const assignment = Array(players.length).fill(1);
      order.slice(0, targetGTI).forEach(index => { assignment[index] = 0; });
      let cost = assignmentCost(players, assignment, groups);
      for (let iteration = 0; iteration < 900; iteration += 1) {
        const gti = [], haavk = [];
        assignment.forEach((side, index) => (side === 0 ? gti : haavk).push(index));
        const left = gti[Math.floor(Math.random() * gti.length)];
        const right = haavk[Math.floor(Math.random() * haavk.length)];
        assignment[left] = 1;
        assignment[right] = 0;
        const nextCost = assignmentCost(players, assignment, groups);
        const temperature = Math.max(.05, 3 * (1 - iteration / 900));
        if (nextCost < cost || Math.random() < Math.exp((cost - nextCost) / temperature)) cost = nextCost;
        else { assignment[left] = 0; assignment[right] = 1; }
        if (!best || cost < best.cost) best = { cost, assignment: [...assignment] };
      }
    }
    const teams = { GTI: [], HAAVK: [] };
    players.forEach((player, index) => teams[best.assignment[index] === 0 ? "GTI" : "HAAVK"].push({ ...player }));
    teams.GTI.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
    teams.HAAVK.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
    return teams;
  }

  function generateSplit() {
    const names = attendanceNames();
    const unresolved = splitState.unreadableSlots.filter(slot => !slot.name.trim());
    if (unresolved.length) throw new Error(`Enter the ${unresolved.length} unreadable occupied-slot name${unresolved.length === 1 ? "" : "s"} first.`);
    if (names.length < 2) throw new Error("At least two players are required.");
    if (names.length > 40) throw new Error("The lobby supports at most 40 players.");
    const players = prepareBalancePlayers(names);
    const parsedGroups = parseKeepGroups(players);
    if (parsedGroups.missing.length) throw new Error(`Keep-together name not found: ${parsedGroups.missing[0]}`);
    const teams = optimizeTeams(players, parsedGroups.groups);
    splitState.result = { teams, groups: parsedGroups.groups };
    splitState.selected = { GTI: "", HAAVK: "" };
    return splitState.result;
  }

  function teamDiagnostics(teams) {
    const skill = Object.fromEntries(Object.entries(teams).map(([team, players]) => [team, players.reduce((sum, player) => sum + player.rating, 0)]));
    const gap = Math.abs(skill.GTI - skill.HAAVK) / Math.max(1, (skill.GTI + skill.HAAVK) / 2) * 100;
    const roleMetrics = ["kills", "assists", "revives", "engineering", "captures", "spawns"];
    const roles = Object.fromEntries(roleMetrics.map(metric => [metric, Object.fromEntries(Object.entries(teams).map(([team, players]) => [team, players.reduce((sum, player) => sum + player.roles[metric], 0)]))]));
    return { skill, gap, roles };
  }

  function splitResultHTML() {
    const result = splitState.result;
    if (!result) return "";
    const diagnostics = teamDiagnostics(result.teams);
    const teamOf = new Map(Object.entries(result.teams).flatMap(([team, players]) => players.map(player => [player.name, team])));
    const separated = result.groups.filter(group => new Set(group.map(name => teamOf.get(name))).size > 1);
    const roleNames = { kills: "Kills", assists: "Assists", revives: "Revive", engineering: "Engineering", captures: "Objective", spawns: "Spawn" };
    const teamHTML = team => `<section class="team-result ${team.toLowerCase()}">
      <div class="team-result-head"><span class="team-chip ${team.toLowerCase()}">${team}${team === "GTI" ? " · attacking" : " · defending"}</span><strong>${result.teams[team].length} players</strong></div>
      <ol class="team-result-list">${result.teams[team].map((player, index) => `<li class="${splitState.selected[team] === player.name ? "selected" : ""}"><span>${index + 1}</span><button type="button" data-select-swap="${escapeHTML(player.name)}" data-swap-team="${team}"><strong>${escapeHTML(player.name)}</strong></button><span class="mini-chip ${player.known ? "known" : "new"}">${player.known ? player.rating.toFixed(1) : "random"}</span><select class="squad-select" data-squad-player="${escapeHTML(player.name)}" data-squad-team="${team}" aria-label="Assign ${escapeHTML(player.name)} to squad"><option value="">—</option>${["A","B","C","D","E"].map(letter => `<option${player.squad === letter ? " selected" : ""}>${letter}</option>`).join("")}</select></li>`).join("")}</ol>
    </section>`;
    return `<div style="margin-top:18px">
      <div class="balance-summary"><div><span>GTI team rating</span><strong>${diagnostics.skill.GTI.toFixed(1)}</strong></div><div class="balance-gap"><span>Rating gap</span><strong>${diagnostics.gap.toFixed(2)}%</strong></div><div><span>HAAVK team rating</span><strong>${diagnostics.skill.HAAVK.toFixed(1)}</strong></div></div>
      <div class="role-balance">${Object.entries(roleNames).map(([metric, label]) => `<div class="role-cell"><span>${label}</span><strong>${diagnostics.roles[metric].GTI.toFixed(1)} / ${diagnostics.roles[metric].HAAVK.toFixed(1)}</strong></div>`).join("")}</div>
      ${separated.length ? `<p class="warning">Separated to protect balance: ${separated.map(group => group.map(escapeHTML).join(" + ")).join("; ")}</p>` : result.groups.length ? `<p class="success-note">All keep-together preferences were preserved.</p>` : ""}
      <div class="toolbar">
        <button class="button" type="button" data-swap-selected${splitState.selected.GTI && splitState.selected.HAAVK ? "" : " disabled"}>Swap selected players</button>
        <button class="button" type="button" data-reroll-split>Reroll alternative</button>
        <button class="button" type="button" data-copy-teams>Copy teams</button>
        <span class="help">Select one player from each team to make a manual swap.</span>
      </div>
      <div class="team-results">${teamHTML("GTI")}${teamHTML("HAAVK")}</div>
      <div class="squad-board">${squadSideHTML("GTI")}${squadSideHTML("HAAVK")}</div>
    </div>`;
  }

  function squadSideHTML(team) {
    const players = splitState.result.teams[team];
    return `<section class="squad-side"><div class="match-title-line"><span class="team-chip ${team.toLowerCase()}">${team} manual squads</span><span class="help">${players.filter(player => !player.squad).length} unassigned</span></div><div class="squad-grid" style="margin-top:12px">${["A","B","C","D","E"].map(letter => {
      const members = players.filter(player => player.squad === letter);
      return `<div class="squad-box ${members.length > 4 ? "over" : ""}"><h3><span>Squad ${letter}</span><span>${members.length}/4</span></h3>${members.length ? `<ul>${members.map(player => `<li>${escapeHTML(player.name)}</li>`).join("")}</ul>` : `<span class="help">Empty</span>`}</div>`;
    }).join("")}</div></section>`;
  }

  function renderPlayer(name) {
    const all = aggregatePlayers();
    const player = all.find(item => item.name === name);
    if (!player) return renderNotFound("Player not found");
    const appearances = [];
    matches.forEach(match => Object.entries(match.teams).forEach(([team, rows]) => {
      const data = rows.find(item => item.name === name);
      if (data) appearances.push({ match, team, data });
    }));
    appearances.sort((a, b) => b.match.playedAt.localeCompare(a.match.playedAt));
    app.innerHTML = pageHead("Player history", name, `${player.matches} recorded matches · ${player.wins} wins · ${(player.winRate * 100).toFixed(0)}% win rate`, `<a class="button" href="#players">All players</a>`) +
      `<section class="profile-grid">
        <div class="profile-stat"><span>Total score</span><strong>${fmt(player.score)}</strong></div>
        <div class="profile-stat"><span>Average score</span><strong>${fmt(player.avgScore)}</strong></div>
        <div class="profile-stat"><span>K / D</span><strong>${player.kd.toFixed(2)}</strong></div>
        <div class="profile-stat"><span>Assists</span><strong>${fmt(player.assists)}</strong></div>
        <div class="profile-stat"><span>Revives</span><strong>${fmt(player.revives)}</strong></div>
        <div class="profile-stat"><span>Engineering</span><strong>${fmt(player.engineering)}</strong></div>
        <div class="profile-stat"><span>Captures</span><strong>${fmt(player.captures)}</strong></div>
        <div class="profile-stat"><span>Spawn on</span><strong>${fmt(player.spawns)}</strong></div>
      </section>
      <div class="table-shell"><table aria-label="${escapeHTML(name)} match history"><thead><tr><th>#</th><th>Match</th><th>Team</th>${METRICS.map(metric => `<th>${LABELS[metric]}</th>`).join("")}</tr></thead>
      <tbody>${appearances.map((item, index) => `<tr><td>${index + 1}</td><td><button class="player-link" data-match="${escapeHTML(item.match.id)}">${escapeHTML(item.match.map)} · ${displayDate(item.match.playedAt)}</button></td><td><span class="team-chip ${item.team.toLowerCase()}">${item.team}</span></td>${METRICS.map(metric => `<td>${fmt(item.data[metric])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function rowsToText(match) {
    if (!match) return "";
    return Object.entries(match.teams).flatMap(([team, rows]) => rows.map(data => [team, data.name, ...METRICS.map(metric => data[metric])].join("\t"))).join("\n");
  }

  function renderImport(editId = "") {
    const editing = matches.find(item => item.id === editId);
    pendingScreenshot = editing?.screenshot || "";
    app.innerHTML = pageHead(
      editing ? "Correction workflow" : "Local entry",
      editing ? `Edit ${editing.map}` : "Add match",
      "Attach the source screenshot, paste one player per line, review the table, then save. Nothing is uploaded online."
    ) + `<form id="match-form" class="panel" data-edit-id="${escapeHTML(editId)}">
      <div class="form-grid">
        <label>Map<input name="map" required value="${escapeHTML(editing?.map || "")}" placeholder="Threshold"></label>
        <label>Played at<input name="playedAt" type="datetime-local" step="1" required value="${escapeHTML(editing?.playedAt || "")}"></label>
        <label>Winner<select name="winner"><option${editing?.winner === "GTI" ? " selected" : ""}>GTI</option><option${editing?.winner === "HAAVK" ? " selected" : ""}>HAAVK</option></select></label>
        <label>Result shown<select name="result"><option${editing?.result === "Victory" ? " selected" : ""}>Victory</option><option${editing?.result === "Defeat" ? " selected" : ""}>Defeat</option></select></label>
      </div>
      <div class="import-grid" style="margin-top:16px">
        <section>
          <label>Original screenshot<input id="screenshot-input" type="file" accept="image/*"></label>
          <div class="dropzone" id="screenshot-preview">${pendingScreenshot ? `<img src="${escapeHTML(pendingScreenshot)}" alt="Attached scoreboard screenshot">` : "Select the complete scoreboard screenshot"}</div>
        </section>
        <section>
          <label>Scoreboard rows<textarea id="row-input" name="rows" required spellcheck="false" placeholder="GTI, Player name, 28884, 36, 32, 25, 16, 8, 13, 27">${escapeHTML(rowsToText(editing))}</textarea></label>
          <p class="help">Required order: <code>team, player, score, kills, deaths, assists, revives, engineering, captures, spawns</code>. Tabs or commas both work.</p>
          <div class="toolbar"><button class="button" type="button" data-preview-import>Preview rows</button><button class="button primary" type="submit">${editing ? "Save corrections" : "Save match"}</button></div>
        </section>
      </div>
      <div id="import-preview"></div>
    </form>
    <section class="panel" style="margin-top:16px"><h2>Data controls</h2><div class="toolbar">
      <label class="button" style="display:inline-flex">Restore backup<input id="restore-backup" type="file" accept="application/json" hidden></label>
      <button class="button danger" type="button" data-reset-data>Restore the four supplied matches</button>
    </div><p class="help">Restoring the supplied matches removes local edits and any matches you added. Download a backup first if you may need them.</p></section>`;
  }

  function parseRows(text) {
    const rows = { GTI: [], HAAVK: [] };
    const errors = [];
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      const parts = line.includes("\t") ? line.split("\t") : line.split(/\s*,\s*/);
      if (parts.length !== 10) {
        errors.push(`Line ${index + 1}: expected 10 fields, found ${parts.length}`);
        return;
      }
      const team = parts[0].trim().toUpperCase();
      const name = parts[1].trim();
      const values = parts.slice(2).map(Number);
      if (!rows[team]) errors.push(`Line ${index + 1}: team must be GTI or HAAVK`);
      else if (!name) errors.push(`Line ${index + 1}: player name is empty`);
      else if (values.some(value => !Number.isFinite(value) || value < 0)) errors.push(`Line ${index + 1}: statistics must be non-negative numbers`);
      else rows[team].push(Object.fromEntries([["name", name], ...METRICS.map((metric, i) => [metric, values[i]])]));
    });
    if (!rows.GTI.length) errors.push("No GTI players found");
    if (!rows.HAAVK.length) errors.push("No HAAVK players found");
    return { rows, errors };
  }

  function renderImportPreview() {
    const target = document.querySelector("#import-preview");
    const parsed = parseRows(document.querySelector("#row-input").value);
    if (parsed.errors.length) {
      target.innerHTML = `<div class="panel" style="margin-top:16px"><h3>Fix these rows</h3><p class="help">${parsed.errors.map(escapeHTML).join("<br>")}</p></div>`;
      return parsed;
    }
    target.innerHTML = `<div class="stats-strip" style="margin-top:16px">
      <div class="stat-card"><span>GTI players</span><strong>${parsed.rows.GTI.length}</strong></div>
      <div class="stat-card"><span>HAAVK players</span><strong>${parsed.rows.HAAVK.length}</strong></div>
      <div class="stat-card"><span>Total rows</span><strong>${parsed.rows.GTI.length + parsed.rows.HAAVK.length}</strong></div>
      <div class="stat-card"><span>Combined score</span><strong>${fmt(teamTotal(parsed.rows.GTI) + teamTotal(parsed.rows.HAAVK))}</strong></div>
    </div>`;
    return parsed;
  }

  async function compressImage(file) {
    const dataUrl = await readFileDataURL(file);
    const image = await loadImage(dataUrl);
    const maxWidth = 1600;
    const scale = Math.min(1, maxWidth / image.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", .82);
  }

  function readFileDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = source;
    });
  }

  function lobbySlotRects(image) {
    const wideLayout = image.naturalWidth / image.naturalHeight > 2.17;
    const layout = wideLayout ? {
      width: 1884, height: 831,
      columns: [82, 450, 820, 1188], nameWidth: 235,
      groups: [202, 412, 623], rowStep: 40, rowHeight: 36,
      avatarOffset: 39, avatarWidth: 36, avatarHeight: 35
    } : {
      width: 1197, height: 578,
      columns: [66, 313, 566, 813], nameWidth: 175,
      groups: [132, 278, 421], rowStep: 28, rowHeight: 25,
      avatarOffset: 25, avatarWidth: 23, avatarHeight: 24
    };
    const scaleX = image.naturalWidth / layout.width;
    const scaleY = image.naturalHeight / layout.height;
    const columns = layout.columns.map((x, index) => ({ x, team: index < 2 ? "GTI" : "HAAVK" }));
    const activeGroups = [
      [0, 0, "A"], [1, 0, "B"], [0, 1, "C"], [1, 1, "D"], [0, 2, "E"],
      [2, 0, "A"], [3, 0, "B"], [2, 1, "C"], [3, 1, "D"], [2, 2, "E"]
    ];
    return activeGroups.flatMap(([columnIndex, groupIndex, squad]) => Array.from({ length: 4 }, (_, row) => ({
      team: columns[columnIndex].team,
      squad,
      slot: row + 1,
      x: columns[columnIndex].x * scaleX,
      y: (layout.groups[groupIndex] + row * layout.rowStep) * scaleY,
      width: layout.nameWidth * scaleX,
      height: layout.rowHeight * scaleY,
      avatar: {
        x: (columns[columnIndex].x - layout.avatarOffset) * scaleX,
        y: (layout.groups[groupIndex] + row * layout.rowStep) * scaleY,
        width: layout.avatarWidth * scaleX,
        height: layout.avatarHeight * scaleY
      }
    })));
  }

  function cropForOCR(image, rect, multiplier = 3) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width * multiplier));
    canvas.height = Math.max(1, Math.round(rect.height * multiplier));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    let brightPixels = 0;
    for (let index = 0; index < pixels.data.length; index += 4) {
      const red = pixels.data[index];
      const green = pixels.data[index + 1];
      const blue = pixels.data[index + 2];
      const luminance = red * .2126 + green * .7152 + blue * .0722;
      if (luminance > 88) brightPixels += 1;
      const value = Math.round(luminance);
      pixels.data[index] = value;
      pixels.data[index + 1] = value;
      pixels.data[index + 2] = value;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    canvas.dataset.brightPixels = String(brightPixels / (multiplier * multiplier));
    return canvas;
  }

  function slotLooksOccupied(image, rect) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.avatar.width));
    canvas.height = Math.max(1, Math.round(rect.avatar.height));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, rect.avatar.x, rect.avatar.y, rect.avatar.width, rect.avatar.height, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0;
    let totalSquared = 0;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722;
      total += luminance;
      totalSquared += luminance * luminance;
      count += 1;
    }
    const mean = total / Math.max(1, count);
    const deviation = Math.sqrt(Math.max(0, totalSquared / Math.max(1, count) - mean * mean));
    return deviation > 18;
  }

  function cleanOCRCandidate(value) {
    const candidate = String(value || "").normalize("NFKC")
      .replace(/[\r\n]+/g, " ")
      .replace(/[¦｜]/g, "|")
      .replace(/[‐‑‒–—―]/g, "-")
      .replace(/\s*\|\s*/g, " | ")
      .replace(/[^\p{L}\p{N}|•·・._\- ]/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[|._\- ]+|[|._\- ]+$/g, "")
      .trim();
    if (candidate.length < 2 || !/[\p{L}\p{N}]/u.test(candidate)) return "";
    if (/^(squad|attack|defen[cs]e|room)$/i.test(candidate)) return "";
    return candidate;
  }

  function updateOCRProgress(progress, status) {
    splitState.progress = Math.max(0, Math.min(100, Math.round(progress)));
    splitState.status = status;
    const bar = document.querySelector("#ocr-progress-bar");
    const label = document.querySelector("#ocr-status");
    if (bar) bar.style.setProperty("--progress", `${splitState.progress}%`);
    if (label) label.textContent = status;
  }

  async function extractLobbyAttendance() {
    if (!splitState.image) return;
    if (location.protocol === "file:") {
      updateOCRProgress(0, "Open the site with start.bat or start.sh. Screenshot reading requires the included local server.");
      return;
    }
    if (!window.Tesseract?.createWorker) {
      updateOCRProgress(0, "The local name reader could not start. You can still paste the names manually.");
      return;
    }
    let worker;
    try {
      updateOCRProgress(2, "Loading the local name reader…");
      const image = await loadImage(splitState.image);
      const baseURL = new URL(".", location.href);
      worker = await window.Tesseract.createWorker("eng", 1, {
        workerPath: new URL("worker.min.js", baseURL).href,
        corePath: new URL("./", baseURL).href,
        langPath: new URL("./", baseURL).href.replace(/\/$/, ""),
        gzip: false,
        logger: message => {
          if (message.status === "loading tesseract core") updateOCRProgress(4 + (message.progress || 0) * 8, "Loading the local OCR engine…");
          if (message.status === "loading language traineddata") updateOCRProgress(12 + (message.progress || 0) * 8, "Loading the local English name model…");
          if (message.status === "initializing api") updateOCRProgress(20 + (message.progress || 0) * 5, "Preparing lobby recognition…");
        }
      });

      await worker.setParameters({
        tessedit_pageseg_mode: window.Tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist: "",
        preserve_interword_spaces: "1"
      });
      const names = [];
      const seen = new Set();
      const unreadableSlots = [];
      const rects = lobbySlotRects(image);
      for (let index = 0; index < rects.length; index += 1) {
        const rect = rects[index];
        if (slotLooksOccupied(image, rect)) {
          const crop = cropForOCR(image, rect, 3);
          const result = await worker.recognize(crop);
          const recognizedText = result.data.text.trim();
          const raw = /[:：]/.test(recognizedText) ? "" : cleanOCRCandidate(recognizedText);
          let accepted = false;
          if (raw && raw.length <= 32 && result.data.confidence >= 35) {
            const resolved = resolvePlayerName(raw);
            if (normalizeIdentity(raw).length >= 3 || resolved.profile) {
              const output = resolved.profile && resolved.confidence >= .72 ? resolved.name : raw;
              const key = normalizeIdentity(output);
              if (key && !seen.has(key)) {
                seen.add(key);
                names.push(output);
                accepted = true;
              }
            }
          }
          if (!accepted) unreadableSlots.push({ team: rect.team, squad: rect.squad, slot: rect.slot, name: "" });
        }
        updateOCRProgress(25 + ((index + 1) / rects.length) * 72, `Checking Squad A–E slots… ${index + 1} / ${rects.length}`);
      }
      splitState.namesText = names.join("\n");
      splitState.unreadableSlots = unreadableSlots;
      splitState.result = null;
      splitState.status = `Read ${names.length} occupied Squad A–E name${names.length === 1 ? "" : "s"}.${unreadableSlots.length ? ` ${unreadableSlots.length} occupied slot${unreadableSlots.length === 1 ? " needs" : "s need"} manual correction.` : " Review the names, then generate teams."}`;
      splitState.progress = 100;
      renderSplit();
      showToast("Lobby names extracted. Review them before balancing.");
    } catch (error) {
      console.warn("Lobby OCR failed", error);
      updateOCRProgress(0, "Automatic extraction failed. You can paste one player name per line and continue.");
      showToast("Could not extract that lobby screenshot.");
    } finally {
      if (worker) await worker.terminate();
    }
  }

  function syncSplitInputs() {
    const namesInput = document.querySelector("#attendance-names");
    const groupsInput = document.querySelector("#keep-groups");
    if (namesInput) splitState.namesText = namesInput.value;
    if (groupsInput) splitState.groupsText = groupsInput.value;
  }

  function formatTeamsText() {
    if (!splitState.result) return "";
    return ["GTI (ATTACKING)", "HAAVK (DEFENDING)"].map((heading, index) => {
      const team = index === 0 ? "GTI" : "HAAVK";
      const players = splitState.result.teams[team];
      const sections = [heading, `${players.length} players`];
      ["A", "B", "C", "D", "E"].forEach(letter => {
        const members = players.filter(player => player.squad === letter);
        if (members.length) sections.push(`Squad ${letter}:\n${members.map(player => `- ${player.name}`).join("\n")}`);
      });
      const unassigned = players.filter(player => !player.squad);
      if (unassigned.length) sections.push(`Unassigned:\n${unassigned.map(player => `- ${player.name}`).join("\n")}`);
      return sections.join("\n");
    }).join("\n\n");
  }

  function saveMatchFromForm(form) {
    const parsed = parseRows(form.elements.rows.value);
    if (parsed.errors.length) {
      renderImportPreview();
      throw new Error("Fix the highlighted row errors before saving.");
    }
    const formData = new FormData(form);
    const editId = form.dataset.editId;
    const playedAt = String(formData.get("playedAt"));
    const map = String(formData.get("map")).trim();
    const id = editId || `${map.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${playedAt.replace(/[^0-9]/g, "")}`;
    if (!pendingScreenshot) throw new Error("Attach the original scoreboard screenshot before saving.");
    if (!editId && matches.some(item => item.id === id)) throw new Error("A match with this map and timestamp already exists.");
    const existing = matches.find(item => item.id === editId);
    const record = {
      id,
      map,
      mode: existing?.mode || "Victory Unite · Custom",
      playedAt,
      result: String(formData.get("result")),
      winner: String(formData.get("winner")),
      screenshot: pendingScreenshot || existing?.screenshot || "",
      teams: parsed.rows
    };
    if (editId) matches = matches.map(item => item.id === editId ? record : item);
    else matches.push(record);
    persist();
    return record;
  }

  function renderNotFound(message) {
    app.innerHTML = pageHead("Not found", message, "The requested local record does not exist.", `<a class="button" href="#leaderboard">Return to leaderboard</a>`);
  }

  function render() {
    const current = route();
    setActiveNav(current.name);
    if (current.name === "leaderboard") renderLeaderboard();
    else if (current.name === "matches") renderMatches();
    else if (current.name === "match") renderMatch(current.value);
    else if (current.name === "players") renderPlayers();
    else if (current.name === "player") renderPlayer(current.value);
    else if (current.name === "split") renderSplit();
    else if (current.name === "import") renderImport(current.value);
    else renderNotFound("Page not found");
    app.focus({ preventScroll: true });
  }

  function showToast(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
  }

  function download(filename, content, type = "application/json") {
    const blob = new Blob([content], { type });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function exportCSV() {
    const headers = ["Rank", "Player", "Matches", "Wins", "Win rate", "Score", "Average score", "Kills", "Deaths", "K/D", "Assists", "Revives", "Engineering", "Captures", "Spawn on"];
    const lines = [headers, ...leaderboardRows().map((p, i) => [i + 1, p.name, p.matches, p.wins, (p.winRate * 100).toFixed(0), p.score, p.avgScore, p.kills, p.deaths, p.kd.toFixed(2), p.assists, p.revives, p.engineering, p.captures, p.spawns])];
    download("df-matchboard-leaderboard.csv", lines.map(line => line.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n"), "text/csv");
  }

  document.addEventListener("click", async event => {
    const player = event.target.closest("[data-player]");
    if (player) location.hash = `player/${encodeURIComponent(player.dataset.player)}`;
    const match = event.target.closest("[data-match]");
    if (match) location.hash = `match/${encodeURIComponent(match.dataset.match)}`;
    const sort = event.target.closest("[data-sort]");
    if (sort) {
      if (sortKey === sort.dataset.sort) sortDirection *= -1;
      else { sortKey = sort.dataset.sort; sortDirection = sortKey === "name" ? 1 : -1; }
      render();
    }
    if (event.target.closest("[data-download-csv]")) exportCSV();
    if (event.target.closest("[data-preview-import]")) renderImportPreview();
    if (event.target.closest("[data-generate-split]") || event.target.closest("[data-reroll-split]")) {
      syncSplitInputs();
      try {
        generateSplit();
        renderSplit();
        document.querySelector("#split-output")?.scrollIntoView({ behavior: "smooth", block: "start" });
        showToast(`Balanced ${splitState.result.teams.GTI.length} for GTI and ${splitState.result.teams.HAAVK.length} for HAAVK.`);
      } catch (error) { showToast(error.message); }
    }
    if (event.target.closest("[data-copy-teams]")) {
      if (!splitState.result) return showToast("Generate teams first.");
      const content = formatTeamsText();
      try {
        await navigator.clipboard.writeText(content);
        showToast("Teams copied to the clipboard.");
      } catch (error) {
        download("df-matchboard-teams.txt", content, "text/plain");
        showToast("Clipboard was unavailable, so the teams were downloaded.");
      }
    }
    const swapChoice = event.target.closest("[data-select-swap]");
    if (swapChoice && splitState.result) {
      const team = swapChoice.dataset.swapTeam;
      splitState.selected[team] = splitState.selected[team] === swapChoice.dataset.selectSwap ? "" : swapChoice.dataset.selectSwap;
      document.querySelector("#split-output").innerHTML = splitResultHTML();
    }
    if (event.target.closest("[data-swap-selected]") && splitState.result) {
      const gtiIndex = splitState.result.teams.GTI.findIndex(player => player.name === splitState.selected.GTI);
      const haavkIndex = splitState.result.teams.HAAVK.findIndex(player => player.name === splitState.selected.HAAVK);
      if (gtiIndex >= 0 && haavkIndex >= 0) {
        const gtiPlayer = { ...splitState.result.teams.GTI[gtiIndex], squad: "" };
        const haavkPlayer = { ...splitState.result.teams.HAAVK[haavkIndex], squad: "" };
        splitState.result.teams.GTI[gtiIndex] = haavkPlayer;
        splitState.result.teams.HAAVK[haavkIndex] = gtiPlayer;
        splitState.selected = { GTI: "", HAAVK: "" };
        document.querySelector("#split-output").innerHTML = splitResultHTML();
        showToast("Players swapped. Their squad assignments were cleared.");
      }
    }
    const view = event.target.closest("[data-view-image]");
    if (view) {
      const record = matches.find(item => item.id === view.dataset.viewImage);
      if (!record?.screenshot) return showToast("No screenshot is attached to this match.");
      dialogImage.src = record.screenshot;
      dialogTitle.textContent = `${record.map} · ${displayDate(record.playedAt)}`;
      imageDialog.showModal();
    }
    if (event.target.closest("[data-close-dialog]")) imageDialog.close();
    const deleting = event.target.closest("[data-delete-match]");
    if (deleting && confirm("Delete this match from the local archive? Download a backup first if you may need it.")) {
      matches = matches.filter(item => item.id !== deleting.dataset.deleteMatch);
      persist();
      location.hash = "matches";
      showToast("Match deleted.");
    }
    if (event.target.closest("[data-reset-data]") && confirm("Replace all local data with the four supplied matches? This cannot be undone without a backup.")) {
      matches = cloneSeed();
      persist();
      renderImport();
      showToast("Supplied matches restored.");
    }
  });

  document.addEventListener("input", event => {
    if (event.target.id === "player-filter") {
      filterText = event.target.value;
      const caret = event.target.selectionStart;
      render();
      const input = document.querySelector("#player-filter");
      input?.focus();
      input?.setSelectionRange(caret, caret);
    }
    if (["attendance-names", "keep-groups"].includes(event.target.id)) {
      syncSplitInputs();
      splitState.result = null;
      const review = document.querySelector("#attendance-review");
      const output = document.querySelector("#split-output");
      if (review) review.innerHTML = attendanceReviewHTML();
      if (output) output.innerHTML = "";
      document.querySelector(".page-head [data-copy-teams]")?.remove();
    }
    const unreadableInput = event.target.closest("[data-unreadable-slot]");
    if (unreadableInput) {
      const slot = splitState.unreadableSlots[Number(unreadableInput.dataset.unreadableSlot)];
      if (slot) slot.name = unreadableInput.value;
      syncSplitInputs();
      splitState.result = null;
      const review = document.querySelector("#attendance-review");
      const output = document.querySelector("#split-output");
      if (review) review.innerHTML = attendanceReviewHTML();
      if (output) output.innerHTML = "";
      document.querySelector(".page-head [data-copy-teams]")?.remove();
    }
  });

  document.addEventListener("change", async event => {
    if (event.target.id === "attendance-image-input" && event.target.files[0]) {
      try {
        splitState.image = await readFileDataURL(event.target.files[0]);
        splitState.namesText = "";
        splitState.unreadableSlots = [];
        splitState.result = null;
        splitState.progress = 1;
        splitState.status = "Preparing the lobby screenshot…";
        renderSplit();
        await extractLobbyAttendance();
      } catch (error) {
        console.warn("Could not read lobby image", error);
        showToast("Could not read that lobby screenshot.");
      }
    }
    const squadSelect = event.target.closest("[data-squad-player]");
    if (squadSelect && splitState.result) {
      const team = squadSelect.dataset.squadTeam;
      const player = splitState.result.teams[team].find(item => item.name === squadSelect.dataset.squadPlayer);
      const targetSquad = squadSelect.value;
      const occupants = splitState.result.teams[team].filter(item => item.squad === targetSquad && item.name !== player?.name).length;
      if (targetSquad && occupants >= 4) {
        document.querySelector("#split-output").innerHTML = splitResultHTML();
        showToast(`Squad ${targetSquad} already has four players.`);
      } else if (player) {
        player.squad = targetSquad;
        document.querySelector("#split-output").innerHTML = splitResultHTML();
      }
    }
    if (event.target.id === "screenshot-input" && event.target.files[0]) {
      try {
        pendingScreenshot = await compressImage(event.target.files[0]);
        document.querySelector("#screenshot-preview").innerHTML = `<img src="${pendingScreenshot}" alt="Attached scoreboard screenshot">`;
        showToast("Screenshot attached locally.");
      } catch (error) { showToast("Could not read that image."); }
    }
    if (event.target.id === "restore-backup" && event.target.files[0]) {
      try {
        const restored = JSON.parse(await event.target.files[0].text());
        if (!Array.isArray(restored.matches)) throw new Error("Invalid backup");
        matches = restored.matches;
        persist();
        location.hash = "matches";
        showToast("Backup restored.");
      } catch (error) { showToast("That file is not a valid DF Matchboard backup."); }
    }
  });

  document.addEventListener("submit", event => {
    if (event.target.id !== "match-form") return;
    event.preventDefault();
    try {
      const record = saveMatchFromForm(event.target);
      location.hash = `match/${encodeURIComponent(record.id)}`;
      showToast("Match saved locally.");
    } catch (error) { showToast(error.message); }
  });

  document.querySelector("#export-backup").addEventListener("click", () => {
    download(`df-matchboard-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), matches }, null, 2));
    showToast("Backup downloaded.");
  });

  imageDialog.addEventListener("click", event => {
    if (event.target === imageDialog) imageDialog.close();
  });

  window.addEventListener("hashchange", render);

  function registerWebMCP() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const register = tool => Promise.resolve(context.registerTool(tool)).catch(error => console.warn("WebMCP registration failed", error));
    register({
      name: "get_leaderboard",
      title: "Get leaderboard",
      description: "Return the cumulative local player leaderboard sorted by total score.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => aggregatePlayers().sort((a,b) => b.score - a.score)
    });
    register({
      name: "list_matches",
      title: "List matches",
      description: "List every match in the local scoreboard archive.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => matches.map(({ id, map, playedAt, winner, result, teams }) => ({ id, map, playedAt, winner, result, players: teams.GTI.length + teams.HAAVK.length }))
    });
  }

  registerWebMCP();
  render();
})();

