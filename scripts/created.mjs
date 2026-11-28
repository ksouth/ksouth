#!/usr/bin/env node
// Builds the "Repositories I made" page: every repository ksouth created,
// forks excluded, read straight from GitHub so each row shows that repo's own
// live description.
//
// One shipped build: created.html lists every repository she has committed to —
// ones she created, plus forks she actually pushed work into — including the
// private ones, as metadata only. A second, narrower build is
// kept for the day the list has to be public-only:
//   node scripts/created.mjs                      the page (everything)
//     created.html + data/created.json
//   node scripts/created.mjs --visibility=public  public repos only
//     created-public.html + data/created-public.json
//     taken from the public /users/ endpoint, so a private name cannot leak
//
// The shipped build needs a *user* token: /user/repos refuses the built-in
// GITHUB_TOKEN (an installation token) with 403. Without INVENTORY_TOKEN it
// leaves the committed page and data untouched and says what to add, rather
// than quietly publishing a public-only list as the real thing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'ksouth';
const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const visibility = (args.find((a) => a.startsWith('--visibility=')) || '--visibility=all').split('=')[1];
if (!['all', 'public'].includes(visibility)) {
  throw new Error(`--visibility must be all or public, not ${visibility}`);
}

const outArg = (args.find((a) => a.startsWith('--out=')) || '').split('=')[1];
const OUT = visibility === 'public'
  ? {
      html: outArg ? path.resolve(ROOT, outArg) : path.join(ROOT, 'created-public.html'),
      json: path.join(ROOT, 'data', 'created-public.json'),
    }
  : {
      html: outArg ? path.resolve(ROOT, outArg) : path.join(ROOT, 'created.html'),
      json: path.join(ROOT, 'data', 'created.json'),
    };
const TEMPLATE = path.join(ROOT, 'scripts', 'created.template.html');

function notice(lines) {
  for (const line of lines) console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(summary, [
      `### The ${visibility} created-repositories page was not rebuilt`,
      '',
      ...lines.map((line) => `- ${line}`),
      '',
    ].join('\n'));
  }
}

function degrade(reason) {
  console.log(`::warning::${reason}`);
  notice([
    reason,
    `Nothing was written: ${path.basename(OUT.html)} and ${path.basename(OUT.json)} are unchanged.`,
    'To fix it once: create a personal access token with the `repo` scope and save it as the `INVENTORY_TOKEN` secret in this repository (Settings → Secrets and variables → Actions → New repository secret).',
  ]);
  process.exit(0);
}

function getToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function headers(token) {
  const head = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'repo-inventory-created-page',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) head.Authorization = `Bearer ${token}`;
  return head;
}

const token = getToken();

async function fetchCreated() {
  if (visibility === 'all') {
    if (!token) degrade('No GitHub token is available, so the repository list cannot be read.');
    if (process.env.HAS_INVENTORY_TOKEN === 'false') {
      degrade('`INVENTORY_TOKEN` is not set. The automatic `GITHUB_TOKEN` cannot read private repositories, and this page is meant to include them.');
    }

    const who = await fetch('https://api.github.com/user', { headers: headers(token) });
    if (who.status === 401) degrade('The token was rejected by GitHub (401).');
    if (!who.ok) degrade(`GitHub returned HTTP ${who.status} reading the authenticated user.`);
    const user = await who.json();
    if (user.login !== OWNER) degrade(`The token belongs to @${user.login}, not @${OWNER}, so it would produce someone else's list.`);

    const repos = [];
    for (let page = 1; page <= 20; page += 1) {
      const res = await fetch(
        `https://api.github.com/user/repos?affiliation=owner&per_page=100&page=${page}&sort=pushed`,
        { headers: headers(token) },
      );
      if (res.status === 403 || res.status === 404) {
        degrade(`\`/user/repos\` returned ${res.status}, which means the token cannot list private repositories.`);
      }
      if (!res.ok) degrade(`GitHub returned HTTP ${res.status} listing repositories.`);
      const batch = await res.json();
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return repos;
  }

  // Public build: the public endpoint, so even a token with private access
  // cannot put a private repository on this page.
  const repos = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await fetch(
      `https://api.github.com/users/${OWNER}/repos?per_page=100&page=${page}&type=owner&sort=pushed`,
      { headers: headers(token) },
    );
    if (!res.ok) degrade(`GitHub returned HTTP ${res.status} listing public repositories.`);
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

const all = await fetchCreated();
if (!all.length) degrade('The API returned no repositories, which looks wrong, so the page was not rewritten.');

// A repository qualifies if she created it, or if it is a fork carrying at least
// one commit authored by her. The commit check reads the default branch only:
// work that exists solely on a non-default branch would not be caught, which is
// the honest limit of this rule.
async function forkHasHerCommits(repo) {
  const branch = encodeURIComponent(repo.default_branch || 'main');
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${repo.name}/commits?author=${OWNER}&sha=${branch}&per_page=1`,
    { headers: headers(token) },
  );
  if (res.status === 409 || res.status === 404) return false;
  if (!res.ok) {
    degrade(`GitHub returned HTTP ${res.status} checking commits in ${repo.name}; the page was not rewritten rather than guessed.`);
  }
  const commits = await res.json();
  return Array.isArray(commits) && commits.length > 0;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const forks = all.filter((repo) => repo.fork === true);
const created = all.filter((repo) => repo.fork !== true);
const pushedForks = [],
  idleForks = [];
await mapLimit(forks, 6, async (repo) => {
  if (!(await forkHasHerCommits(repo))) {
    idleForks.push(repo);
    return;
  }
  // The list endpoint omits `parent`, so the fork's upstream comes from the
  // single-repository endpoint. Only the qualifying forks pay for this call.
  if (!repo.parent) {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo.name}`, { headers: headers(token) });
    if (!res.ok) degrade(`GitHub returned HTTP ${res.status} reading ${repo.name}, so its upstream could not be named.`);
    const detail = await res.json();
    if (detail.parent) repo.parent = detail.parent;
  }
  pushedForks.push(repo);
});
const qualified = [...created, ...pushedForks];
if (!qualified.length) degrade('The API returned no repositories, which looks wrong, so the page was not rewritten.');

// An empty repository answers 409 to the commits endpoint. Those rows say so
// plainly rather than looking like a repository with nothing to report.
const emptyNames = new Set();
await mapLimit(qualified, 6, async (repo) => {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo.name}/commits?per_page=1`, { headers: headers(token) });
  if (res.status === 409) emptyNames.add(repo.name);
  else if (!res.ok) degrade(`GitHub returned HTTP ${res.status} checking whether ${repo.name} has commits.`);
});

const selected = visibility === 'public' ? qualified.filter((repo) => repo.private !== true) : qualified;
if (visibility === 'public' && selected.length !== qualified.length) {
  degrade('The public endpoint returned private repositories, which should be impossible; the public page was not written.');
}

// GitHub caps a repository description at 350 characters (a 422 comes back past
// that), so the description column never needs truncating here: whatever the API
// returns is the whole text.
function shape(repo) {
  return {
    name: repo.name,
    html_url: repo.html_url,
    description: repo.description || '',
    homepage: repo.homepage || '',
    language: repo.language || '',
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    created_at: repo.created_at || '',
    pushed_at: repo.pushed_at || '',
    archived: Boolean(repo.archived),
    private: Boolean(repo.private),
    fork: Boolean(repo.fork),
    empty: emptyNames.has(repo.name),
    upstream: repo.fork && repo.parent
      ? { name: repo.parent.full_name, url: repo.parent.html_url }
      : null,
  };
}

const data = {
  owner: OWNER,
  visibility,
  generated_at: new Date().toISOString(),
  source: visibility === 'public'
    ? `GET /users/${OWNER}/repos, forks excluded, private excluded`
    : 'GET /user/repos?affiliation=owner, forks excluded, private included',
  includes_private: visibility === 'all',
  repos: selected.map(shape).sort((a, b) => a.name.localeCompare(b.name, 'en')),
};

const literal = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const template = fs.readFileSync(TEMPLATE, 'utf8');
fs.mkdirSync(path.dirname(OUT.html), { recursive: true });
fs.writeFileSync(OUT.html, template.split('__DATA__').join(literal(data)));
fs.mkdirSync(path.dirname(OUT.json), { recursive: true });
fs.writeFileSync(OUT.json, JSON.stringify(data, null, 2) + '\n');

const privateCount = data.repos.filter((repo) => repo.private).length;
const described = data.repos.filter((repo) => repo.description.trim()).length;
console.log(
  `${visibility} build: ${data.repos.length} repositories with commits by @${OWNER} — ` +
  `${created.length} created, ${pushedForks.length} forked and pushed to ` +
  `(${privateCount} private, ${described} with a description, ` +
  `${data.repos.filter((repo) => repo.archived).length} archived); ` +
  `${idleForks.length} untouched forks skipped, ${emptyNames.size} empty → ${path.basename(OUT.html)}`,
);
