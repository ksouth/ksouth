#!/usr/bin/env node
// Builds the two profile cards under docs/cards/: PROFILE STATS and a 26-week
// commit graph, each in a light and a dark variant at 495x240.
//
//   node scripts/profile-cards.mjs
//
// Every card is one plain SVG document — rectangles and text, no <style>, no
// <script>, no SMIL — so there is nothing that can animate and every frame is
// the same frame. Public data only. If collection fails nothing is written, so
// the committed cards keep their last good values.

import fs from 'node:fs';
import path from 'node:path';

const LOGIN = 'ksouth';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'cards');
const TZ = 'Australia/Melbourne';
const WIDTH = 495;
const HEIGHT = 240;
const WEEKS = 26;
const DAY = 86_400_000;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const NUMBER = new Intl.NumberFormat('en-AU');

const THEMES = {
  light: { bg: '#ffffff', fg: '#111111', muted: '#6b6b6b', accent: '#0000c8', empty: 0.07 },
  dark: { bg: '#0e0e0e', fg: '#e9e9e9', muted: '#9b9b9b', accent: '#1800f8', empty: 0.22 },
};
const LEVEL_OPACITY = [0.28, 0.5, 0.74, 1];

let token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

function log(message) {
  console.log(message);
}

function headers(extra = {}) {
  const base = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ksouth-profile-cards',
    ...extra,
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: headers(options.headers),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${url} returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function collectProfile() {
  const user = await request(`https://api.github.com/users/${LOGIN}`);
  return {
    publicRepos: user.public_repos,
    followers: user.followers,
    following: user.following,
  };
}

const CONTRIBUTIONS_QUERY = `query($login: String!, $yearFrom: DateTime!, $recentFrom: DateTime!, $until: DateTime!) {
  user(login: $login) {
    year: contributionsCollection(from: $yearFrom, to: $until) {
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
    recent: contributionsCollection(from: $recentFrom, to: $until) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

async function collectContributions() {
  const now = new Date();
  const year = Number(new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric' }).format(now));
  const body = await request('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: CONTRIBUTIONS_QUERY,
      variables: {
        login: LOGIN,
        yearFrom: `${year}-01-01T00:00:00Z`,
        recentFrom: new Date(now.getTime() - (WEEKS + 2) * 7 * DAY).toISOString(),
        until: now.toISOString(),
      },
    }),
  });
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  const user = body.data?.user;
  if (!user) throw new Error('GraphQL returned no user');
  return {
    year,
    yearDays: user.year.contributionCalendar.weeks.flatMap((week) => week.contributionDays),
    totalContributions: user.year.contributionCalendar.totalContributions,
    recentWeeks: user.recent.contributionCalendar.weeks.slice(-WEEKS),
  };
}

function currentStreak(days) {
  let index = days.length - 1;
  if (index >= 0 && days[index].contributionCount === 0) index -= 1;
  let streak = 0;
  while (index >= 0 && days[index].contributionCount > 0) {
    streak += 1;
    index -= 1;
  }
  return streak;
}

function longestStreak(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

function intensity(counts) {
  const sorted = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const cuts = [at(0.25), at(0.5), at(0.75)];
  return (count) => {
    if (count === 0) return 0;
    if (count <= cuts[0]) return 1;
    if (count <= cuts[1]) return 2;
    if (count <= cuts[2]) return 3;
    return 4;
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function dayLabel(days) {
  return `${days} day${days === 1 ? '' : 's'}`;
}

function document(theme, title, description, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family='${FONT}' role="img" aria-labelledby="card-title">
<title id="card-title">${escapeXml(title)}</title>
<desc>${escapeXml(description)}</desc>
<rect width="${WIDTH}" height="${HEIGHT}" rx="8" fill="${theme.bg}"/>
<rect x="1.5" y="1.5" width="${WIDTH - 3}" height="${HEIGHT - 3}" rx="7" fill="none" stroke="${theme.accent}" stroke-width="3"/>
${body}
</svg>
`;
}

function heading(theme, text) {
  return `<text x="26" y="44" font-size="13" font-weight="600" letter-spacing="1.6" fill="${theme.accent}">${escapeXml(text)}</text>`;
}

function statsCard(theme, stats) {
  const figures = [
    [NUMBER.format(stats.publicRepos), 'PUBLIC REPOS'],
    [NUMBER.format(stats.followers), 'FOLLOWERS'],
    [NUMBER.format(stats.following), 'FOLLOWING'],
  ];
  const columns = figures
    .map(([value, label], index) => {
      const centre = round(26 + (443 * (index + 0.5)) / 3);
      return `<text x="${centre}" y="150" text-anchor="middle" font-size="38" font-weight="600" fill="${theme.fg}">${escapeXml(value)}</text>
<text x="${centre}" y="176" text-anchor="middle" font-size="11" font-weight="600" letter-spacing="1.3" fill="${theme.muted}">${label}</text>`;
    })
    .join('\n');
  const description = `Profile stats: ${figures[0][0]} public repositories, ${figures[1][0]} followers, ${figures[2][0]} following.`;
  return document(theme, 'Profile stats', description, `${heading(theme, 'PROFILE STATS')}\n${columns}`);
}

function commitCard(theme, contributions) {
  const counts = contributions.recentWeeks.flatMap((week) => week.contributionDays.map((day) => day.contributionCount));
  const level = intensity(counts);
  const size = 11;
  const gap = 4;
  const gridWidth = WEEKS * size + (WEEKS - 1) * gap;
  const gridX = round((WIDTH - gridWidth) / 2);
  const gridY = 58;

  const squares = contributions.recentWeeks
    .map((week, column) =>
      week.contributionDays
        .map((day, row) => {
          const step = level(day.contributionCount);
          const opacity = step === 0 ? theme.empty : LEVEL_OPACITY[step - 1];
          const x = round(gridX + column * (size + gap));
          const y = round(gridY + row * (size + gap));
          return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${theme.accent}" fill-opacity="${opacity}"/>`;
        })
        .join('\n'),
    )
    .join('\n');

  const figures = [
    [dayLabel(currentStreak(contributions.yearDays)), 'CURRENT STREAK'],
    [dayLabel(longestStreak(contributions.yearDays)), 'LONGEST STREAK'],
    [NUMBER.format(contributions.totalContributions), `CONTRIBUTIONS ${contributions.year}`],
  ];
  const columns = figures
    .map(([value, label], index) => {
      const centre = round(26 + (443 * (index + 0.5)) / 3);
      return `<text x="${centre}" y="190" text-anchor="middle" font-size="22" font-weight="600" fill="${theme.fg}">${escapeXml(value)}</text>
<text x="${centre}" y="210" text-anchor="middle" font-size="10" font-weight="600" letter-spacing="1.1" fill="${theme.muted}">${escapeXml(label)}</text>`;
    })
    .join('\n');

  const description = `Commit graph: ${WEEKS} weeks of contributions, current streak ${figures[0][0]}, longest streak ${figures[1][0]}, ${figures[2][0]} contributions in ${contributions.year}.`;
  return document(theme, 'Commit activity', description, `${heading(theme, 'COMMIT ACTIVITY')}\n${squares}\n${columns}`);
}

function writeCard(name, svg) {
  const file = path.join(OUT_DIR, name);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (previous === svg) return { file, changed: false, bytes: Buffer.byteLength(svg) };
  fs.writeFileSync(file, svg);
  return { file, changed: true, bytes: Buffer.byteLength(svg) };
}

async function main() {
  const [stats, contributions] = await Promise.all([collectProfile(), collectContributions()]);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    written.push(writeCard(`profile-stats-${name}.svg`, statsCard(theme, stats)));
    written.push(writeCard(`commit-graph-${name}.svg`, commitCard(theme, contributions)));
  }

  for (const card of written) {
    log(`${card.changed ? 'Wrote' : 'Unchanged'} ${path.relative(ROOT, card.file)} (${card.bytes} bytes)`);
  }
  log(
    `Stats: ${NUMBER.format(stats.publicRepos)} public repos, ${NUMBER.format(stats.followers)} followers, ${NUMBER.format(stats.following)} following. ` +
      `Activity: ${dayLabel(currentStreak(contributions.yearDays))} current streak, ${dayLabel(longestStreak(contributions.yearDays))} longest, ` +
      `${NUMBER.format(contributions.totalContributions)} contributions in ${contributions.year}.`,
  );
}

main().catch((error) => {
  console.error(`Profile cards failed, leaving the last good cards in place: ${error.message}`);
  process.exit(1);
});
