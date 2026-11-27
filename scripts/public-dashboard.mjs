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

const BATCH_SIZE = 20;
const REPOS_PER_USER = 5;
const BATCH_PAUSE_MS = 900;
const FOLLOWED_WINDOW_DAYS = 30;
const HISTORY_LOOKBACK_DAYS = 7;
const HISTORY_MAX_ITEMS = 20_000;
const STARS_PER_PERSON = 5;
const LISTS_PER_BATCH = 2;
const LIST_ITEMS_PER_PAGE = 100;
const STARRED_REPOS_PER_PAGE = 100;
const REPOSITORY_TOPICS_PER_PAGE = 20;
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

    if (!text && res.ok) {
      if (attempt <= 2) {
        const waitMs = 2000 * attempt;
        log(`  Empty response from ${href}, retry ${attempt} after ${waitMs / 1000}s.`);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw new Error(`${options.method || 'GET'} ${href} returned an empty HTTP ${res.status} response after retries.`);
    }

    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok && attempt <= 2) {
        const waitMs = 2000 * attempt;
        log(`  Non-JSON response from ${href}, retry ${attempt} after ${waitMs / 1000}s.`);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw new Error(`${options.method || 'GET'} ${href} returned non-JSON HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    if (res.ok && body === null) {
      if (attempt <= 2) {
        const waitMs = 2000 * attempt;
        log(`  Null response from ${href}, retry ${attempt} after ${waitMs / 1000}s.`);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw new Error(`${options.method || 'GET'} ${href} returned a null HTTP ${res.status} response after retries.`);
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
  const errors = response.body?.errors ?? [];
  if (errors.length) throw new Error(`${label} query failed: ${errors.slice(0, 3).map((error) => error.message).join('; ')}`);
  if (!response.body?.data) throw new Error(`${label} query returned no data.`);
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
    const data = await graphql(buildQuery(batch), 'Followed-account data');
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
        const node = edge?.node;
        if (!node || node.visibility !== 'PUBLIC' || !edge.starredAt) continue;
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
    lists.push(...page.nodes.filter((list) => list && !list.isPrivate).map((list) => ({ ...list, items: [] })));
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
        `l${index}: node(id: ${JSON.stringify(list.id)}) { ... on UserList { items(first: ${LIST_ITEMS_PER_PAGE}${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { nodes { ... on Repository { nameWithOwner url description visibility stargazerCount pushedAt isFork parent { stargazerCount } repositoryTopics(first: ${REPOSITORY_TOPICS_PER_PAGE}) { totalCount nodes { topic { name } } } } } pageInfo { hasNextPage endCursor } } } }`,
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
            stargazerCount: item.stargazerCount ?? 0,
            pushedAt: item.pushedAt ?? null,
            isFork: Boolean(item.isFork),
            parentStars: item.parent?.stargazerCount ?? null,
            topics: item.repositoryTopics?.nodes?.map((entry) => entry?.topic?.name).filter(Boolean) ?? [],
            topicsCount: item.repositoryTopics?.totalCount ?? 0,
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
    const connection = `starredRepositories(first: ${STARRED_REPOS_PER_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ''}, orderBy: {field: STARRED_AT, direction: DESC})`;
    const data = await graphql(
      `{ user(login: ${JSON.stringify(OWNER)}) { ${connection} { edges { starredAt node { nameWithOwner url description visibility stargazerCount pushedAt isFork parent { stargazerCount } repositoryTopics(first: ${REPOSITORY_TOPICS_PER_PAGE}) { totalCount nodes { topic { name } } } } } pageInfo { hasNextPage endCursor } } } }`,
      'Starred repositories',
    );
    const page = data.user?.starredRepositories;
    if (!page || !Array.isArray(page.edges)) throw new Error('Starred repositories were missing from GitHub.');
    stars.push(...page.edges.filter((edge) => edge?.node?.visibility === 'PUBLIC').map((edge) => ({
      nameWithOwner: edge.node.nameWithOwner,
      url: edge.node.url,
      description: edge.node.description ?? '',
      stargazerCount: edge.node.stargazerCount ?? 0,
      pushedAt: edge.node.pushedAt ?? null,
      isFork: Boolean(edge.node.isFork),
      parentStars: edge.node.parent?.stargazerCount ?? null,
      topics: edge.node.repositoryTopics?.nodes?.map((entry) => entry?.topic?.name).filter(Boolean) ?? [],
      topicsCount: edge.node.repositoryTopics?.totalCount ?? 0,
      starredAt: edge.starredAt ?? null,
    })));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo?.hasNextPage && !after) throw new Error('GitHub returned a starred-repository page without a cursor.');
  } while (after);
  return stars;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function formatStars(value) {
  return new Intl.NumberFormat('en-AU').format(value);
}

function listItemMarkup(repo) {
  const [owner, name] = repo.nameWithOwner.split('/', 2);
  const stars = repo.isFork
    ? repo.parentStars === null || repo.parentStars === undefined
      ? 'Original stars unavailable'
      : `${formatStars(repo.parentStars)} ★ original`
    : `${formatStars(repo.stargazerCount)} stars`;
  const pushed = repo.pushedAt ? repo.pushedAt.slice(0, 10) : 'Unknown';
  const starred = repo.starredAt ? repo.starredAt.slice(0, 10) : 'Unknown';
  const description = repo.description ? `<p class="description">${escapeHtml(repo.description.replace(/\s+/g, ' ').trim())}</p>` : '';
  const topicMarkup = repo.topics.slice(0, 4).map((topic) => `<span class="topic">${escapeHtml(topic.toLowerCase())}</span>`).join('');
  const topicCount = repo.topicsCount ?? repo.topics.length;
  const topicMore = topicCount > 4 ? `<span class="topic-more">+${topicCount - 4}</span>` : '';
  const topics = topicMarkup || topicMore ? `<div class="topics">${topicMarkup}${topicMore}</div>` : '';
  const search = [owner, name, repo.description, repo.topics.join(' ')].join(' ').toLocaleLowerCase();
  return `<li class="repo-item" data-name="${escapeHtml(name)}" data-owner="${escapeHtml(owner)}" data-stars="${repo.sortStars}" data-pushed="${escapeHtml(repo.pushedAt || '')}" data-search="${escapeHtml(search)}"><div class="repo"><a href="${escapeHtml(repo.url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a><span>by <a href="https://github.com/${escapeHtml(owner)}" target="_blank" rel="noopener">${escapeHtml(owner)}</a></span></div><div class="repo-meta"><span class="stars">${stars}</span><span>Last push: ${pushed}</span><span>Starred: ${starred}</span></div>${description}${topics}</li>`;
}

function renderListPage({ title, description, count, content, dashboardHref, listsHref, generatedAt, script = '' }) {
  const values = {
    TITLE: escapeHtml(title),
    DESCRIPTION: escapeHtml(description),
    COUNT: escapeHtml(count),
    CONTENT: content,
    SCRIPT: script,
    DASHBOARD_HREF: escapeHtml(dashboardHref),
    LISTS_HREF: escapeHtml(listsHref),
    GENERATED_AT: escapeHtml(generatedAt),
  };
  return fs.readFileSync(LIST_TEMPLATE, 'utf8').replace(/__(TITLE|DESCRIPTION|COUNT|CONTENT|SCRIPT|DASHBOARD_HREF|LISTS_HREF|GENERATED_AT)__/g, (_, key) => values[key]);
}

function listControlsScript() {
  return `<script>
(function () {
  var list = document.getElementById("repo-list");
  var rows = Array.from(list.querySelectorAll(".repo-item"));
  var search = document.getElementById("repo-search");
  var sort = document.getElementById("repo-sort");
  var count = document.getElementById("repo-count");
  var empty = document.getElementById("repo-empty");
  function byName(a, b) {
    return a.dataset.name.localeCompare(b.dataset.name, undefined, { sensitivity: "base" }) || a.dataset.owner.localeCompare(b.dataset.owner, undefined, { sensitivity: "base" });
  }
  function render() {
    var query = search.value.trim().toLocaleLowerCase();
    var visible = rows.filter(function (row) { return row.dataset.search.indexOf(query) >= 0; });
    visible.sort(function (a, b) {
      if (sort.value === "name") return byName(a, b);
      if (sort.value === "owner") return a.dataset.owner.localeCompare(b.dataset.owner, undefined, { sensitivity: "base" }) || byName(a, b);
      if (sort.value === "stars") return Number(b.dataset.stars) - Number(a.dataset.stars) || byName(a, b);
      return (Date.parse(b.dataset.pushed) || 0) - (Date.parse(a.dataset.pushed) || 0) || byName(a, b);
    });
    list.replaceChildren.apply(list, visible);
    count.textContent = "Showing " + visible.length + " of " + rows.length + " repositories";
    empty.hidden = visible.length > 0;
  }
  search.addEventListener("input", render);
  sort.addEventListener("change", render);
  render();
})();
</script>`;
}

function writeListPages(lists, starred, generatedAt) {
  const starredByName = new Map(starred.map((repo) => [repo.nameWithOwner, repo]));
  for (const repo of starred) repo.sortStars = repo.isFork ? repo.parentStars ?? 0 : repo.stargazerCount ?? 0;
  for (const list of lists) {
    for (const item of list.items) {
      item.starredAt = starredByName.get(item.nameWithOwner)?.starredAt ?? null;
      item.sortStars = item.isFork ? item.parentStars ?? 0 : item.stargazerCount ?? 0;
    }
    list.items.sort((a, b) => (Date.parse(b.pushedAt) || 0) - (Date.parse(a.pushedAt) || 0) || a.nameWithOwner.localeCompare(b.nameWithOwner));
  }
  const assigned = new Set(lists.flatMap((list) => list.items.map((item) => item.nameWithOwner)));
  const unfiled = starred.filter((repo) => !assigned.has(repo.nameWithOwner));
  unfiled.sort((a, b) => (Date.parse(b.pushedAt) || 0) - (Date.parse(a.pushedAt) || 0) || a.nameWithOwner.localeCompare(b.nameWithOwner));
  const card = (name, slug, description, count, sortable) => {
    const attributes = sortable
      ? ` data-sortable="true" data-name="${escapeHtml(name)}" data-count="${count}"`
      : ' data-sortable="false"';
    return `<a class="list-card" href="./${escapeHtml(slug)}/"${attributes}><h2>${escapeHtml(name)}</h2><p>${escapeHtml(description || 'No description.')}</p><span class="card-count">${count} public repositories</span></a>`;
  };
  const sortedLists = [...lists].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  const cards = sortedLists.map((list) => card(list.name, list.slug, list.description, list.items.length, true));
  cards.push(card('Not in any list', 'unfiled', 'Public repositories you have starred but not added to a public list.', unfiled.length, false));
  const sortScript = `<script>
(function () {
  var select = document.getElementById("list-sort");
  var grid = document.getElementById("list-grid");
  var cards = Array.from(grid.querySelectorAll('.list-card[data-sortable="true"]'));
  var unfiled = grid.querySelector('.list-card[data-sortable="false"]');
  function sortCards() {
    cards.sort(function (a, b) {
      if (select.value === "name") return a.dataset.name.localeCompare(b.dataset.name, undefined, { sensitivity: "base" });
      return Number(b.dataset.count) - Number(a.dataset.count) || a.dataset.name.localeCompare(b.dataset.name, undefined, { sensitivity: "base" });
    });
    cards.forEach(function (card) { grid.appendChild(card); });
    if (unfiled) grid.appendChild(unfiled);
  }
  select.addEventListener("change", sortCards);
  sortCards();
})();
</script>`;
  const hubHtml = renderListPage({
    title: 'GitHub star lists',
    description: `Browse ${lists.length} public lists and the public stars not filed into any of them.`,
    count: `${lists.length} lists · ${unfiled.length} unfiled stars`,
    content: `<div class="sort-controls"><label for="list-sort">Sort lists</label><select id="list-sort" aria-label="Sort the public star lists"><option value="count" selected>Most repositories</option><option value="name">Name</option></select></div><section class="list-grid" id="list-grid" aria-label="Public star lists">${cards.join('')}</section>`,
    script: sortScript,
    dashboardHref: '../index.html',
    listsHref: './index.html',
    generatedAt,
  });
  fs.mkdirSync(OUT_LISTS, { recursive: true });
  fs.writeFileSync(path.join(OUT_LISTS, 'index.html'), hubHtml);
  for (const list of lists) {
    const items = list.items.map(listItemMarkup).join('');
    const content = `<div class="repo-controls"><div class="field"><label for="repo-search">Search</label><input id="repo-search" type="search" placeholder="Name, owner, description or topics" aria-label="Search repositories"></div><div class="field"><label for="repo-sort">Sort by</label><select id="repo-sort" aria-label="Sort repositories"><option value="pushed" selected>Last push (newest)</option><option value="name">Repo name (A–Z)</option><option value="owner">Owner (A–Z)</option><option value="stars">Stars (most)</option></select></div><p class="result-count" id="repo-count" aria-live="polite">Showing ${list.items.length} of ${list.items.length} repositories</p></div><ol class="repos" id="repo-list">${items}</ol><p class="empty" id="repo-empty" hidden>${list.items.length ? 'No repositories match these filters.' : 'This list has no public repositories.'}</p>`;
    const html = renderListPage({
      title: list.name,
      description: list.description || 'A public GitHub star list.',
      count: `${list.items.length} public repositories`,
      content,
      script: listControlsScript(),
      dashboardHref: '../../index.html',
      listsHref: '../index.html',
      generatedAt,
    });
    const directory = path.join(OUT_LISTS, list.slug);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), html);
  }
  const unfiledRows = unfiled.map(listItemMarkup).join('');
  const content = `<div class="repo-controls"><div class="field"><label for="repo-search">Search</label><input id="repo-search" type="search" placeholder="Name, owner, description or topics" aria-label="Search repositories"></div><div class="field"><label for="repo-sort">Sort by</label><select id="repo-sort" aria-label="Sort repositories"><option value="pushed" selected>Last push (newest)</option><option value="name">Repo name (A–Z)</option><option value="owner">Owner (A–Z)</option><option value="stars">Stars (most)</option></select></div><p class="result-count" id="repo-count" aria-live="polite">Showing ${unfiled.length} of ${unfiled.length} repositories</p></div><ol class="repos" id="repo-list">${unfiledRows}</ol><p class="empty" id="repo-empty" hidden>${unfiled.length ? 'No repositories match these filters.' : 'Every public starred repository is in a public list.'}</p>`;
  const unfiledHtml = renderListPage({
    title: 'Not in any list',
    description: 'Public repositories you have starred but not added to a public list.',
    count: `${unfiled.length} public stars`,
    content,
    script: listControlsScript(),
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
  const lists = await fetchPublicLists();
  const publicStars = await fetchAllPublicStars();
  log(`Read ${lists.length} public star lists and ${publicStars.length} public starred repositories.`);

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

  writeListPages(lists, publicStars, meta.generatedAtLocal);

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
