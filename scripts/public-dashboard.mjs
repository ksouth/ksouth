#!/usr/bin/env node
// Builds the public dashboard served by GitHub Pages from docs/.
// Public data only: it never reads, writes or needs the private repo, and holds
// no credentials beyond the workflow's own GITHUB_TOKEN. No dependencies.
//
//   node scripts/public-dashboard.mjs
//
// Writes the dashboard, repo/star histories, and a top-five star state index.
// If collection fails, outputs aren't written so the last good pages remain.

import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'ksouth';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_HTML = path.join(ROOT, 'docs', 'index.html');
const OUT_SUMMARY = path.join(ROOT, 'docs', 'data', 'summary.json');
const OUT_HISTORY = path.join(ROOT, 'docs', 'data', 'history.json');
const OUT_STAR_HISTORY = path.join(ROOT, 'docs', 'data', 'star-history.json');
const OUT_STAR_STATE = path.join(ROOT, 'state', 'stars.json');
const TEMPLATE = path.join(ROOT, 'scripts', 'dashboard.template.html');

const BATCH_SIZE = 40;
const REPOS_PER_USER = 5;
const BATCH_PAUSE_MS = 900;
const FOLLOWED_WINDOW_DAYS = 30;
const HISTORY_LOOKBACK_DAYS = 7;
const HISTORY_MAX_ITEMS = 20_000;
const STARS_PER_PERSON = 5;
const DAY = 86_400_000;
const TZ = 'Australia/Melbourne';

let token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

function log(message) {
  console.log(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(extra = {}) {
  const base = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ksouth-dashboard',
    ...extra,
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

async function api(href, options = {}) {
  let attempt = 1;
  for (;;) {
    const res = await fetch(href, {
      ...options,
      headers: headers(options.headers),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const rateLimited =
      (res.status === 403 || res.status === 429) && /secondary rate limit|abuse|rate limit/i.test(text);

    if ((res.status === 401 || res.status === 403) && !rateLimited && token && attempt === 1) {
      log(`  Authenticated ${options.method || 'GET'} ${href} returned HTTP ${res.status}; retrying without a token for public data.`);
      token = '';
      attempt += 1;
      continue;
    }

    if (rateLimited && attempt <= 3) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = retryAfter ? retryAfter * 1000 : 20_000 * attempt;
      log(`  Rate limited (HTTP ${res.status}); waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}.`);
      await sleep(waitMs);
      attempt += 1;
      continue;
    }
    if (res.status >= 500 && attempt === 1) {
      log(`  ${res.status} from ${href}, retrying once.`);
      await sleep(2000);
      attempt += 1;
      continue;
    }

    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${options.method || 'GET'} ${href} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { body, link: res.headers.get('link') };
  }
}

function nextLink(link) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(link || '');
  return match ? match[1] : null;
}

async function paginate(url) {
  const items = [];
  let href = url;
  while (href) {
    const page = await api(href);
    items.push(...page.body);
    href = nextLink(page.link);
  }
  return items;
}

async function fetchPublicRepos() {
  const repos = await paginate(`https://api.github.com/users/${OWNER}/repos?per_page=100&type=owner&sort=created`);
  return repos.filter((repo) => repo.owner?.login?.toLowerCase() === OWNER.toLowerCase() && !repo.private);
}

async function fetchFollows() {
  const users = await paginate(`https://api.github.com/users/${OWNER}/following?per_page=100`);
  return users.map((user) => user.login);
}

function buildQuery(logins) {
  const fields = 'nameWithOwner name url description stargazerCount primaryLanguage { name } createdAt isFork parent { nameWithOwner } visibility';
  const starFields = 'nameWithOwner name url description stargazerCount primaryLanguage { name } visibility';
  const aliases = logins.map(
    (login, index) =>
      `u${index}: repositoryOwner(login: ${JSON.stringify(login)}) { __typename login ` +
      `... on User { repositories(first: ${REPOS_PER_USER}, ownerAffiliations: OWNER, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } } ` +
      `starredRepositories(first: ${STARS_PER_PERSON}, orderBy: {field: STARRED_AT, direction: DESC}) { edges { starredAt node { ${starFields} } } } } ` +
      `... on Organization { repositories(first: ${REPOS_PER_USER}, affiliations: OWNER, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } } } }`,
  );
  return `{ rateLimit { remaining resetAt } ${aliases.join('\n')} }`;
}

async function fetchFollowedData(follows, since) {
  const batches = [];
  for (let i = 0; i < follows.length; i += BATCH_SIZE) batches.push(follows.slice(i, i + BATCH_SIZE));

  const repos = [];
  const stars = [];
  const resolvedLogins = [];
  const ownersWithRepos = [];
  const unresolvedLogins = [];
  for (const [index, batch] of batches.entries()) {
    const res = await api('https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: buildQuery(batch) }),
    });
    const data = res.body.data || {};
    for (const [accountIndex, requestedLogin] of batch.entries()) {
      const value = data[`u${accountIndex}`];
      if (!value?.repositories || !Array.isArray(value.repositories.nodes)) {
        unresolvedLogins.push(requestedLogin);
        continue;
      }
      resolvedLogins.push(value.login);
      if (value.repositories.nodes.length) ownersWithRepos.push(value.login);
      for (const node of value.repositories.nodes) {
        if (!node || node.visibility !== 'PUBLIC' || Date.parse(node.createdAt) < since) continue;
        repos.push({
          o: value.login,
          n: node.name,
          u: node.url,
          f: Boolean(node.isFork),
          p: node.parent?.nameWithOwner ?? '',
          l: node.primaryLanguage?.name ?? '',
          s: node.stargazerCount ?? 0,
          d: node.description ?? '',
          fs: node.createdAt.slice(0, 10),
          c: node.createdAt.slice(0, 10),
        });
      }
      for (const edge of value.starredRepositories?.edges ?? []) {
        const node = edge.node;
        if (!node || node.visibility !== 'PUBLIC') continue;
        stars.push({
          starred_by: value.login,
          nameWithOwner: node.nameWithOwner,
          url: node.url,
          language: node.primaryLanguage?.name ?? '',
          stars: node.stargazerCount ?? 0,
          description: node.description ?? '',
          starredAt: edge.starredAt,
        });
      }
    }
    if (index < batches.length - 1) await sleep(BATCH_PAUSE_MS);
  }
  return {
    repos: repos.sort((a, b) => b.fs.localeCompare(a.fs) || a.n.localeCompare(b.n)),
    stars: stars.sort((a, b) => b.starredAt.localeCompare(a.starredAt) || a.nameWithOwner.localeCompare(b.nameWithOwner)),
    resolvedLogins,
    ownersWithRepos,
    unresolvedLogins,
  };
}

const melbourneDate = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const melbourneStamp = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const zone = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, timeZoneName: 'short' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${zone}`;
};

const isoDate = (value) => (value ? value.slice(0, 10) : '');

function activityFor(repo, now) {
  if (repo.archived) return 'Archived';
  if (!repo.pushed_at) return 'Idle';
  const days = (now - Date.parse(repo.pushed_at)) / DAY;
  if (days <= 30) return 'Active';
  if (days <= 180) return 'Quiet';
  return 'Idle';
}

function readHistory() {
  if (!fs.existsSync(OUT_HISTORY)) return [];
  const history = JSON.parse(fs.readFileSync(OUT_HISTORY, 'utf8'));
  if (!Array.isArray(history) || history.some((entry) => !entry.date || !Array.isArray(entry.items))) {
    throw new Error('docs/data/history.json is not a valid daily history.');
  }
  return history;
}

function appendHistory(history, followed, startedAt) {
  const today = melbourneDate(startedAt);
  const seen = new Set(history.flatMap((entry) => entry.items.map((item) => `${item.owner}/${item.name}`)));
  const newItems = followed
    .filter((repo) => startedAt.getTime() - Date.parse(repo.c) <= HISTORY_LOOKBACK_DAYS * DAY && !seen.has(`${repo.o}/${repo.n}`))
    .map((repo) => ({
      owner: repo.o,
      name: repo.n,
      url: repo.u,
      type: repo.f ? 'fork' : 'source',
      parent: repo.p || null,
      language: repo.l,
      stars: repo.s,
      description: repo.d,
      first_seen: today,
    }));

  if (!newItems.length) return { history, changed: false, newCount: 0 };

  const existingIndex = history.findIndex((entry) => entry.date === today);
  const existingItems = existingIndex >= 0 ? history[existingIndex].items : [];
  const merged = new Map(existingItems.map((item) => [`${item.owner}/${item.name}`, item]));
  for (const item of newItems) merged.set(`${item.owner}/${item.name}`, item);
  const entry = {
    date: today,
    generated_at: startedAt.toISOString(),
    items: [...merged.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name)),
  };
  const next = [entry, ...history.filter((item) => item.date !== today)].sort((a, b) => b.date.localeCompare(a.date));
  let itemCount = next.reduce((sum, day) => sum + day.items.length, 0);
  while (itemCount > HISTORY_MAX_ITEMS && next.length) itemCount -= next.pop().items.length;
  return { history: next, changed: true, newCount: newItems.length };
}

function readStarState() {
  if (!fs.existsSync(OUT_STAR_STATE)) return {};
  const state = JSON.parse(fs.readFileSync(OUT_STAR_STATE, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state/stars.json is not a valid star state.');
  return state;
}

function readStarHistory() {
  if (!fs.existsSync(OUT_STAR_HISTORY)) return [];
  const history = JSON.parse(fs.readFileSync(OUT_STAR_HISTORY, 'utf8'));
  if (!Array.isArray(history) || history.some((entry) => !entry.date || !Array.isArray(entry.items))) {
    throw new Error('docs/data/star-history.json is not a valid daily star history.');
  }
  return history;
}

function appendStarHistory(history, stars, state, startedAt) {
  const today = melbourneDate(startedAt);
  const firstRun = Object.keys(state).length === 0;
  const newStars = [];
  for (const star of stars) {
    const key = `${star.starred_by}/${star.nameWithOwner}`;
    if (state[key]?.starred_at === star.starredAt) continue;
    state[key] = {
      first_seen: state[key]?.first_seen ?? (firstRun ? star.starredAt.slice(0, 10) : today),
      starred_by: star.starred_by,
      starred_at: star.starredAt,
    };
    if (!firstRun || startedAt.getTime() - Date.parse(star.starredAt) <= HISTORY_LOOKBACK_DAYS * DAY) {
      newStars.push({
        starred_by: star.starred_by,
        nameWithOwner: star.nameWithOwner,
        url: star.url,
        language: star.language,
        stars: star.stars,
        description: star.description,
        first_seen: today,
      });
    }
  }

  if (!newStars.length) return { history, changed: false, newCount: 0, state };

  const todayIndex = history.findIndex((entry) => entry.date === today);
  const current = todayIndex >= 0 ? history[todayIndex].items : [];
  const merged = new Map(current.map((item) => [`${item.starred_by}/${item.nameWithOwner}`, item]));
  for (const item of newStars) merged.set(`${item.starred_by}/${item.nameWithOwner}`, item);
  const entry = {
    date: today,
    generated_at: startedAt.toISOString(),
    items: [...merged.values()].sort((a, b) => a.starred_by.localeCompare(b.starred_by) || a.nameWithOwner.localeCompare(b.nameWithOwner)),
  };
  const next = [entry, ...history.filter((day) => day.date !== today)].sort((a, b) => b.date.localeCompare(a.date));
  let count = next.reduce((sum, day) => sum + day.items.length, 0);
  while (count > HISTORY_MAX_ITEMS && next.length) count -= next.pop().items.length;
  return { history: next, changed: true, newCount: newStars.length, state };
}

async function main() {
  const startedAt = new Date();
  const now = startedAt.getTime();

  const repos = await fetchPublicRepos();
  log(`Read ${repos.length} public repositories.`);

  const follows = await fetchFollows();
  if (!token) throw new Error('no token available for GraphQL');
  const followed = await fetchFollowedData(follows, now - FOLLOWED_WINDOW_DAYS * DAY);
  const resolved = new Set(followed.resolvedLogins.map((login) => login.toLowerCase()));
  const ownersWithRepos = new Set(followed.ownersWithRepos.map((login) => login.toLowerCase()));
  const unresolved = follows.filter((login) => !resolved.has(login.toLowerCase()));
  log(`Checked ${follows.length} followed accounts: ${resolved.size} profiles resolved, ${ownersWithRepos.size} with public repos, ${unresolved.length} unresolved.`);
  if (unresolved.length) throw new Error(`Could not query followed accounts: ${unresolved.join(', ')}`);
  log(`Read ${followed.repos.length} public repos created in the last ${FOLLOWED_WINDOW_DAYS} days and ${followed.stars.length} recent stars.`);

  const historyUpdate = appendHistory(readHistory(), followed.repos, startedAt);
  const starUpdate = appendStarHistory(readStarHistory(), followed.stars, readStarState(), startedAt);

  const rows = repos.map((repo) => ({
    n: repo.name,
    u: repo.html_url,
    v: repo.private ? 'Private' : 'Public',
    f: Boolean(repo.fork),
    a: Boolean(repo.archived),
    l: repo.language ?? '',
    s: repo.stargazers_count ?? 0,
    o: repo.open_issues_count ?? 0,
    c: isoDate(repo.created_at),
    p: isoDate(repo.pushed_at),
    t: (repo.topics ?? []).join(', '),
    d: repo.description ?? '',
    fs: isoDate(repo.created_at),
    act: activityFor(repo, now),
  }));

  const languages = new Map();
  for (const row of rows) {
    if (!row.l) continue;
    languages.set(row.l, (languages.get(row.l) ?? 0) + 1);
  }
  const topLanguage = [...languages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';

  const summary = {
    generated_at: startedAt.toISOString(),
    total_public_repos: rows.length,
    new_last_7_days: rows.filter((row) => Date.parse(`${row.c}T00:00:00Z`) >= now - 7 * DAY).length,
    active_last_30_days: rows.filter((row) => row.act === 'Active').length,
    top_language: topLanguage,
  };

  const meta = {
    generatedAt: melbourneDate(startedAt),
    generatedAtISO: startedAt.toISOString(),
    generatedAtLocal: melbourneStamp(startedAt),
    owner: OWNER,
    privateIncluded: false,
    showPrivate: false,
    footer:
      'Public repositories only — everything here is what anyone can see on GitHub. ' +
      'Rebuilt every morning from the GitHub API by scripts/public-dashboard.mjs.',
    followedCount: follows.length,
    resolvedCount: resolved.size,
    followingWindow: FOLLOWED_WINDOW_DAYS,
  };

  const literal = (value) =>
    JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = fs
    .readFileSync(TEMPLATE, 'utf8')
    .split('__META__').join(literal(meta))
    .split('__DATA__').join(literal({ repos: rows, following: followed.repos }));

  fs.mkdirSync(path.dirname(OUT_SUMMARY), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_STAR_STATE), { recursive: true });
  fs.writeFileSync(OUT_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  if (historyUpdate.changed) {
    fs.writeFileSync(OUT_HISTORY, `${JSON.stringify(historyUpdate.history, null, 2)}\n`);
  }
  fs.writeFileSync(OUT_STAR_HISTORY, `${JSON.stringify(starUpdate.history, null, 2)}\n`);
  fs.writeFileSync(OUT_STAR_STATE, `${JSON.stringify(Object.fromEntries(Object.entries(starUpdate.state).sort((a, b) => a[0].localeCompare(b[0]))), null, 2)}\n`);
  fs.writeFileSync(OUT_HTML, html);

  log(
    `Wrote docs/index.html (${rows.length} repos, ${follows.length} followed), docs/data/summary.json, ` +
      `and docs/data/history.json (${historyUpdate.history.reduce((sum, day) => sum + day.items.length, 0)} logged, ` +
      `${historyUpdate.newCount} new today${historyUpdate.changed ? '' : ', unchanged'}); ` +
      `docs/data/star-history.json (${starUpdate.history.reduce((sum, day) => sum + day.items.length, 0)} logged, ` +
      `${starUpdate.newCount} new today).`,
  );
}

main().catch((error) => {
  console.error(`Public dashboard failed, leaving the last good page in place: ${error.message}`);
  process.exit(1);
});
