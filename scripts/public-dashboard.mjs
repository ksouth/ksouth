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
const OUT_LISTS = path.join(ROOT, 'docs', 'lists');
const TEMPLATE = path.join(ROOT, 'scripts', 'dashboard.template.html');
const LIST_TEMPLATE = path.join(ROOT, 'scripts', 'lists.template.html');

const BATCH_SIZE = 10;
const REPOS_PER_USER = 5;
const BATCH_PAUSE_MS = 900;
const FOLLOWED_WINDOW_DAYS = 30;
const HISTORY_LOOKBACK_DAYS = 7;
const HISTORY_MAX_ITEMS = 20_000;
const STARS_PER_PERSON = 5;
const LISTS_PER_BATCH = 10;
const LIST_ITEMS_PER_PAGE = 100;
const STARRED_REPOS_PER_PAGE = 100;
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
    if (res.status >= 500 && attempt <= 2) {
      const waitMs = 2000 * attempt;
      log(`  ${res.status} from ${href}, retry ${attempt} after ${waitMs / 1000}s.`);
      await sleep(waitMs);
      attempt += 1;
      continue;
    }

    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${options.method || 'GET'} ${href} returned non-JSON HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
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

async function graphql(query, label) {
  const response = await api('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const errors = response.body.errors ?? [];
  if (errors.length) throw new Error(`${label} query failed: ${errors.slice(0, 3).map((error) => error.message).join('; ')}`);
  if (!response.body.data) throw new Error(`${label} query returned no data.`);
  return response.body.data;
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
  const fields = 'nameWithOwner name url description stargazerCount primaryLanguage { name } createdAt isFork parent { nameWithOwner url stargazerCount } visibility';
  const starFields = 'nameWithOwner name url description stargazerCount primaryLanguage { name } visibility isFork parent { nameWithOwner url stargazerCount }';
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
    if (res.body.errors?.some((error) => error.type === 'RESOURCE_LIMITS_EXCEEDED')) {
      throw new Error(`GraphQL resource limit exceeded in a ${batch.length}-account batch.`);
    }
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
          pu: node.parent?.url ?? '',
          ps: node.parent?.stargazerCount ?? null,
          l: node.primaryLanguage?.name ?? '',
          s: node.stargazerCount ?? 0,
          d: node.description ?? '',
          fs: node.createdAt.slice(0, 10),
          c: node.createdAt.slice(0, 10),
        });
      }
      for (const edge of value.starredRepositories?.edges ?? []) {
        if (!edge?.node) continue;
        const node = edge.node;
        if (node.visibility !== 'PUBLIC') continue;
        stars.push({
          starred_by: value.login,
          nameWithOwner: node.nameWithOwner,
          url: node.url,
          language: node.primaryLanguage?.name ?? '',
          stars: node.stargazerCount ?? 0,
          description: node.description ?? '',
          is_fork: Boolean(node.isFork),
          parent: node.parent?.nameWithOwner ?? null,
          parent_url: node.parent?.url ?? null,
          parent_stars: node.parent?.stargazerCount ?? null,
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

async function fetchPublicLists() {
  const lists = [];
  let after = null;
  do {
    const connection = `lists(first: 100${after ? `, after: ${JSON.stringify(after)}` : ''})`;
    const data = await graphql(
      `{ user(login: ${JSON.stringify(OWNER)}) { ${connection} { nodes { id name slug description isPrivate } pageInfo { hasNextPage endCursor } } } }`,
      'Star-list metadata',
    );
    const page = data.user?.lists;
    if (!page || !Array.isArray(page.nodes)) throw new Error('Star-list metadata was missing from GitHub.');
    lists.push(...page.nodes.filter((list) => !list.isPrivate).map((list) => ({ ...list, items: [] })));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo?.hasNextPage && !after) throw new Error('GitHub returned a star-list page without a cursor.');
  } while (after);

  if (lists.some((list) => list.slug === 'unfiled')) throw new Error('A star list already uses the reserved `unfiled` slug.');
  const slugs = new Set(lists.map((list) => list.slug));
  if (slugs.size !== lists.length) throw new Error('GitHub returned duplicate public star-list slugs.');

  let pending = lists.map((list) => ({ list, after: null }));
  while (pending.length) {
    const next = [];
    for (let offset = 0; offset < pending.length; offset += LISTS_PER_BATCH) {
      const batch = pending.slice(offset, offset + LISTS_PER_BATCH);
      const aliases = batch.map(({ list, after: cursor }, index) =>
        `l${index}: node(id: ${JSON.stringify(list.id)}) { ... on UserList { items(first: ${LIST_ITEMS_PER_PAGE}${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { nodes { ... on Repository { nameWithOwner url description visibility primaryLanguage { name } } } pageInfo { hasNextPage endCursor } } } }`,
      );
      const data = await graphql(`{ ${aliases.join('\n')} }`, 'Star-list items');
      for (const [index, { list }] of batch.entries()) {
        const page = data[`l${index}`]?.items;
        if (!page || !Array.isArray(page.nodes)) throw new Error(`GitHub omitted items for the public ${list.slug} list.`);
        const existing = new Set(list.items.map((item) => item.nameWithOwner));
        for (const item of page.nodes) {
          if (!item || item.visibility !== 'PUBLIC' || existing.has(item.nameWithOwner)) continue;
          existing.add(item.nameWithOwner);
          list.items.push({
            nameWithOwner: item.nameWithOwner,
            url: item.url,
            description: item.description ?? '',
            language: item.primaryLanguage?.name ?? '',
          });
        }
        if (page.pageInfo?.hasNextPage) {
          if (!page.pageInfo.endCursor) throw new Error(`GitHub returned an item page without a cursor for ${list.slug}.`);
          next.push({ list, after: page.pageInfo.endCursor });
        }
      }
    }
    pending = next;
  }

  return lists.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchAllPublicStars() {
  const stars = [];
  let after = null;
  do {
    const connection = `starredRepositories(first: ${STARRED_REPOS_PER_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ''})`;
    const data = await graphql(
      `{ user(login: ${JSON.stringify(OWNER)}) { ${connection} { nodes { nameWithOwner url description visibility primaryLanguage { name } } pageInfo { hasNextPage endCursor } } } }`,
      'Starred repositories',
    );
    const page = data.user?.starredRepositories;
    if (!page || !Array.isArray(page.nodes)) throw new Error('Starred repositories were missing from GitHub.');
    stars.push(...page.nodes.filter((repo) => repo?.visibility === 'PUBLIC').map((repo) => ({
      nameWithOwner: repo.nameWithOwner,
      url: repo.url,
      description: repo.description ?? '',
      language: repo.primaryLanguage?.name ?? '',
    })));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo?.hasNextPage && !after) throw new Error('GitHub returned a starred-repository page without a cursor.');
  } while (after);
  return stars;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function listItemMarkup(repo) {
  const [owner, name] = repo.nameWithOwner.split('/', 2);
  const description = repo.description ? `<p class="description">${escapeHtml(repo.description.replace(/\s+/g, ' ').trim())}</p>` : '';
  const language = repo.language ? `<span class="language">${escapeHtml(repo.language)}</span>` : '';
  return `<li><div class="repo"><a href="${escapeHtml(repo.url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a><span>by <a href="https://github.com/${escapeHtml(owner)}" target="_blank" rel="noopener">${escapeHtml(owner)}</a></span></div>${description}${language}</li>`;
}

function renderListPage({ title, headingHtml, byline = '', description, count, content, dashboardHref, listsHref, generatedAt, script = '' }) {
  const values = {
    TITLE: escapeHtml(title),
    HEADING: headingHtml ?? escapeHtml(title),
    BYLINE: byline,
    DESCRIPTION: escapeHtml(description),
    COUNT: escapeHtml(count),
    CONTENT: content,
    SCRIPT: script,
    DASHBOARD_HREF: escapeHtml(dashboardHref),
    LISTS_HREF: escapeHtml(listsHref),
    GENERATED_AT: escapeHtml(generatedAt),
  };
  return fs.readFileSync(LIST_TEMPLATE, 'utf8').replace(/__(TITLE|HEADING|BYLINE|DESCRIPTION|COUNT|CONTENT|SCRIPT|DASHBOARD_HREF|LISTS_HREF|GENERATED_AT)__/g, (_, key) => values[key]);
}

function writeListPages(lists, starred, generatedAt) {
  const assigned = new Set(lists.flatMap((list) => list.items.map((item) => item.nameWithOwner)));
  const unfiled = starred.filter((repo) => !assigned.has(repo.nameWithOwner));
  const card = (name, slug, description, count) =>
    `<a class="list-card" href="./${escapeHtml(slug)}/"><h2>${escapeHtml(name)}</h2><p>${escapeHtml(description || 'No description.')}</p><span class="card-count">${count} public repositories</span></a>`;
  const cards = lists.map((list) => card(list.name, list.slug, list.description, list.items.length));
  cards.push(card('Not in any list', 'unfiled', 'Public repositories you have starred but not added to a public list.', unfiled.length));
  const hubHtml = renderListPage({
    title: '@ksouth GitHub star lists · GitHub star lists',
    headingHtml: `<a class="owner-link" href="https://github.com/${OWNER}">@${OWNER}</a> GitHub star lists`,
    description: `Browse ${lists.length} topical lists and the stars not filed into any of them.`,
    count: `${lists.length} lists · ${unfiled.length} unfiled stars`,
    content: `<section class="list-grid" aria-label="Public star lists">${cards.join('')}</section>`,
    dashboardHref: '../index.html',
    listsHref: './index.html',
    generatedAt,
  });
  fs.mkdirSync(OUT_LISTS, { recursive: true });
  fs.writeFileSync(path.join(OUT_LISTS, 'index.html'), hubHtml);
  for (const list of lists) {
    const items = list.items.map(listItemMarkup).join('');
    const content = items
      ? `<ol class="repos">${items}</ol>`
      : '<p class="empty">This list has no public repositories.</p>';
    const html = renderListPage({
      title: `@${OWNER} list of starred repos: ${list.name}`,
      headingHtml: `<a class="owner-link" href="https://github.com/${OWNER}">@${OWNER}</a> list of starred repos: ${escapeHtml(list.name)}`,
      byline: `<p class="byline">A GitHub star list, by <a href="https://github.com/${OWNER}">@${OWNER}</a>.</p>`,
      description: list.description || 'A public GitHub star list.',
      count: `${list.items.length} public repositories`,
      content,
      dashboardHref: '../../index.html',
      listsHref: '../index.html',
      generatedAt,
    });
    const directory = path.join(OUT_LISTS, list.slug);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), html);
  }
  const content = unfiled.length
    ? `<ol class="repos">${unfiled.map(listItemMarkup).join('')}</ol>`
    : '<p class="empty">Every public starred repository is in a public list.</p>';
  const unfiledHtml = renderListPage({
    title: 'Not in any list · GitHub star lists',
    headingHtml: 'Not in any list',
    description: 'Public repositories you have starred but not added to a public list.',
    count: `${unfiled.length} public stars`,
    content,
    dashboardHref: '../../index.html',
    listsHref: '../index.html',
    generatedAt,
  });
  const unfiledDirectory = path.join(OUT_LISTS, 'unfiled');
  fs.mkdirSync(unfiledDirectory, { recursive: true });
  fs.writeFileSync(path.join(unfiledDirectory, 'index.html'), unfiledHtml);
  log(`Wrote the public star-list hub, ${lists.length} list pages, and ${unfiled.length} unfiled stars.`);
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
  const parentData = new Map(followed.filter((repo) => repo.pu || repo.ps !== null).map((repo) => [`${repo.o}/${repo.n}`, { url: repo.pu, stars: repo.ps }]));
  const currentDay = history.find((entry) => entry.date === today);
  let currentDayEnriched = false;
  if (currentDay) {
    currentDay.items = currentDay.items.map((item) => {
      const parent = item.type === 'fork' ? parentData.get(`${item.owner}/${item.name}`) : null;
      if (!parent || item.parent_url && item.parent_stars !== undefined) return item;
      currentDayEnriched = true;
      return {
        ...item,
        parent_url: item.parent_url ?? parent.url ?? (item.parent ? `https://github.com/${item.parent}` : null),
        parent_stars: item.parent_stars ?? parent.stars ?? null,
      };
    });
  }
  const newItems = followed
    .filter((repo) => startedAt.getTime() - Date.parse(repo.c) <= HISTORY_LOOKBACK_DAYS * DAY && !seen.has(`${repo.o}/${repo.n}`))
    .map((repo) => ({
      owner: repo.o,
      name: repo.n,
      url: repo.u,
      type: repo.f ? 'fork' : 'source',
      parent: repo.p || null,
      parent_url: repo.pu || (repo.p ? `https://github.com/${repo.p}` : null),
      parent_stars: repo.ps,
      language: repo.l,
      stars: repo.s,
      description: repo.d,
      first_seen: today,
    }));

  if (!newItems.length) return { history, changed: currentDayEnriched, newCount: 0 };

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
  const todayIndex = history.findIndex((entry) => entry.date === today);
  const current = todayIndex >= 0 ? history[todayIndex].items : [];
  const currentStars = new Map(stars.map((star) => [`${star.starred_by}/${star.nameWithOwner}`, star]));
  let enriched = false;
  const currentWithParents = current.map((item) => {
    const star = currentStars.get(`${item.starred_by}/${item.nameWithOwner}`);
    if (!star) return item;
    const metadata = {
      is_fork: star.is_fork,
      parent: star.parent,
      parent_url: star.parent_url || (star.parent ? `https://github.com/${star.parent}` : null),
      parent_stars: star.parent_stars,
    };
    if (Object.keys(metadata).every((key) => item[key] === metadata[key])) return item;
    enriched = true;
    return { ...item, ...metadata };
  });
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
        is_fork: star.is_fork,
        parent: star.parent,
        parent_url: star.parent_url || (star.parent ? `https://github.com/${star.parent}` : null),
        parent_stars: star.parent_stars,
        first_seen: today,
      });
    }
  }

  if (!newStars.length && !enriched) return { history, changed: false, newCount: 0, state };

  const merged = new Map(currentWithParents.map((item) => [`${item.starred_by}/${item.nameWithOwner}`, item]));
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

  const publicLists = await fetchPublicLists();
  const publicStars = await fetchAllPublicStars();
  log(`Read ${publicLists.length} public star lists and ${publicStars.length} public starred repositories.`);

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

  const summary = {
    generated_at: startedAt.toISOString(),
    total_public_repos: rows.length,
    new_last_7_days: rows.filter((row) => Date.parse(`${row.c}T00:00:00Z`) >= now - 7 * DAY).length,
    active_last_30_days: rows.filter((row) => row.act === 'Active').length,
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

  writeListPages(publicLists, publicStars, melbourneStamp(startedAt));
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
