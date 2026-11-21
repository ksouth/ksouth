#!/usr/bin/env node
// Builds the public dashboard served by GitHub Pages from docs/.
// Public data only: it never reads, writes or needs the private repo, and holds
// no credentials beyond the workflow's own GITHUB_TOKEN. No dependencies.
//
//   node scripts/public-dashboard.mjs
//
// Writes docs/index.html and docs/data/summary.json, and writes nothing at all
// if collection fails, so a bad run leaves the last good page in place.

import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'ksouth';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_HTML = path.join(ROOT, 'docs', 'index.html');
const OUT_SUMMARY = path.join(ROOT, 'docs', 'data', 'summary.json');
const TEMPLATE = path.join(ROOT, 'scripts', 'dashboard.template.html');

const BATCH_SIZE = 40;
const REPOS_PER_USER = 5;
const BATCH_PAUSE_MS = 900;
const FOLLOWED_WINDOW_DAYS = 30;
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
  const fields = 'nameWithOwner name url description stargazerCount primaryLanguage { name } createdAt isFork parent { nameWithOwner }';
  const aliases = logins.map(
    (login, index) =>
      `u${index}: user(login: ${JSON.stringify(login)}) { login repositories(first: ${REPOS_PER_USER}, ownerAffiliations: OWNER, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } } }`,
  );
  return `{ rateLimit { remaining resetAt } ${aliases.join('\n')} }`;
}

async function fetchFollowedRepos(follows, since) {
  const batches = [];
  for (let i = 0; i < follows.length; i += BATCH_SIZE) batches.push(follows.slice(i, i + BATCH_SIZE));

  const items = [];
  for (const [index, batch] of batches.entries()) {
    const res = await api('https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: buildQuery(batch) }),
    });
    for (const [key, value] of Object.entries(res.body.data || {})) {
      if (key === 'rateLimit' || !value?.repositories) continue;
      for (const node of value.repositories.nodes) {
        if (!node || Date.parse(node.createdAt) < since) continue;
        items.push({
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
    }
    if (index < batches.length - 1) await sleep(BATCH_PAUSE_MS);
  }
  return items.sort((a, b) => b.fs.localeCompare(a.fs) || a.n.localeCompare(b.n));
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

async function main() {
  const startedAt = new Date();
  const now = startedAt.getTime();

  const repos = await fetchPublicRepos();
  log(`Read ${repos.length} public repositories.`);

  const follows = await fetchFollows();
  if (!token) throw new Error('no token available for GraphQL');
  const followed = await fetchFollowedRepos(follows, now - FOLLOWED_WINDOW_DAYS * DAY);
  log(`Read ${followed.length} repositories created in the last ${FOLLOWED_WINDOW_DAYS} days by ${follows.length} followed accounts.`);

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
    generatedAtLocal: melbourneStamp(startedAt),
    owner: OWNER,
    privateIncluded: false,
    showPrivate: false,
    footer:
      'Public repositories only — everything here is what anyone can see on GitHub. ' +
      'Rebuilt every morning from the GitHub API by scripts/public-dashboard.mjs.',
    followedCount: follows.length,
    followingWindow: FOLLOWED_WINDOW_DAYS,
  };

  const literal = (value) =>
    JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = fs
    .readFileSync(TEMPLATE, 'utf8')
    .split('__META__').join(literal(meta))
    .split('__DATA__').join(literal({ repos: rows, following: followed }));

  fs.mkdirSync(path.dirname(OUT_SUMMARY), { recursive: true });
  fs.writeFileSync(OUT_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(OUT_HTML, html);

  log(`Wrote docs/index.html (${rows.length} repos, ${followed.length} followed) and docs/data/summary.json.`);
}

main().catch((error) => {
  console.error(`Public dashboard failed, leaving the last good page in place: ${error.message}`);
  process.exit(1);
});
