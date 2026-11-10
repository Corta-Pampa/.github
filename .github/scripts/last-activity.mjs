#!/usr/bin/env node
// Finds when the selected users were last active across an organization's
// repositories, and writes two files to ACTIVITY_OUT_DIR:
//
//   badge.json     shields.io "endpoint" badge (https://shields.io/badges/endpoint-badge)
//   activity.json  details for humans and scripts (private repos stay anonymous)
//
// No dependencies (Node 18+, global fetch). Run by .github/workflows/activity-badge.yml.
//
// Note: this repository is public, and so are its Actions logs and the
// published files. Nothing written or logged here may name a private repo.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const list = (s = '') => s.split(',').map((x) => x.trim()).filter(Boolean);

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const TOKEN = process.env.GITHUB_TOKEN || '';
const ORG = process.env.ACTIVITY_ORG || 'Corta-Pampa';
const USERS = list(process.env.ACTIVITY_USERS || 'Zindure,Pauldelacv');
const REPOS = list(process.env.ACTIVITY_REPOS); // empty = every repo of the org
const MAX_REPOS = Number(process.env.ACTIVITY_MAX_REPOS || 15);
const LABEL = process.env.ACTIVITY_LABEL || ''; // empty = "last <kind>"
const OUT_DIR = process.env.ACTIVITY_OUT_DIR || 'activity-out';

// Events that count as real work, and the word the badge uses for each.
const KINDS = {
  PushEvent: 'commit',
  PullRequestEvent: 'pull request',
  PullRequestReviewEvent: 'review',
  PullRequestReviewCommentEvent: 'review',
  IssuesEvent: 'issue',
  IssueCommentEvent: 'comment',
  CommitCommentEvent: 'comment',
  CreateEvent: 'branch', // refined with payload.ref_type below
  ReleaseEvent: 'release',
};

const wanted = new Map(USERS.map((u) => [u.toLowerCase(), u]));
const repoName = (repo) => (repo.private ? 'a private repo' : repo.full_name);

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'activity-badge',
      ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub API returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function candidateRepos() {
  if (REPOS.length) {
    return Promise.all(REPOS.map((r) => gh(`/repos/${r.includes('/') ? r : `${ORG}/${r}`}`)));
  }
  const repos = await gh(`/orgs/${ORG}/repos?type=all&sort=pushed&direction=desc&per_page=100`);
  return repos
    .sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at))
    .slice(0, MAX_REPOS);
}

function normalize(ev, repo) {
  let kind = KINDS[ev.type];
  if (ev.type === 'CreateEvent') kind = ev.payload?.ref_type || kind;
  return {
    at: ev.created_at,
    type: ev.type,
    kind,
    actor: ev.actor.login,
    repo: repo.full_name,
    private: Boolean(repo.private),
  };
}

const newer = (a, b) => !b || Date.parse(a.at) > Date.parse(b.at);

// Repo events cover pushes to any branch, PRs, reviews, comments… for the
// last few weeks. `best` maps lowercase login -> most recent normalized event.
async function scanEvents(repo, best) {
  for (let page = 1; page <= 3; page++) {
    const events = await gh(`/repos/${repo.full_name}/events?per_page=100&page=${page}`);
    for (const ev of events) {
      const login = ev.actor?.login?.toLowerCase();
      if (!wanted.has(login) || !KINDS[ev.type]) continue;
      const n = normalize(ev, repo);
      if (newer(n, best.get(login))) best.set(login, n);
    }
    if (events.length < 100) return;
    // Older pages can only matter if some user still has nothing newer.
    const oldest = Date.parse(events.at(-1).created_at);
    const floor = Math.min(...[...wanted.keys()].map((u) => (best.has(u) ? Date.parse(best.get(u).at) : -Infinity)));
    if (oldest < floor) return;
  }
}

// Fallback for quiet periods, when the events feed has nothing left:
// the latest commit authored by the user on each repo's default branch.
async function scanCommits(repo, best) {
  for (const [login, user] of wanted) {
    if (best.has(login)) continue;
    const [c] = await gh(`/repos/${repo.full_name}/commits?author=${encodeURIComponent(user)}&per_page=1`);
    if (!c) continue;
    const n = {
      at: c.commit.committer?.date || c.commit.author.date,
      type: 'Commit',
      kind: 'commit',
      actor: c.author?.login || user,
      repo: repo.full_name,
      private: Boolean(repo.private),
    };
    if (newer(n, best.get(login))) best.set(login, n);
  }
}

// One failing repo (empty, disabled, no access) should not hide the others,
// but a rate limit or an outage must not publish a wrong "no activity" badge.
async function scanAll(repos, scan, best) {
  for (const repo of repos) {
    try {
      await scan(repo, best);
    } catch (err) {
      if (![404, 409, 451].includes(err.status)) {
        throw new Error(`Scanning ${repoName(repo)} failed: ${err.message}`);
      }
      console.warn(`Skipping ${repoName(repo)} (HTTP ${err.status}).`);
    }
  }
}

function ago(ms) {
  const plural = (n, unit) => `${n} ${unit}${n > 1 ? 's' : ''} ago`;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 24) return plural(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 30) return plural(d, 'day');
  if (d < 365) return plural(Math.floor(d / 30), 'month');
  return plural(Math.floor(d / 365), 'year');
}

function color(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return 'brightgreen';
  if (h < 24) return 'green';
  if (h < 24 * 7) return 'yellowgreen';
  if (h < 24 * 30) return 'yellow';
  return 'lightgrey';
}

function badge(last, now) {
  const base = { schemaVersion: 1, namedLogo: 'github', logoColor: 'white', cacheSeconds: 300 };
  if (!last) return { ...base, label: LABEL || 'last activity', message: 'no recent activity', color: 'lightgrey' };
  const age = Math.max(0, now - Date.parse(last.at));
  return { ...base, label: LABEL || `last ${last.kind}`, message: ago(age), color: color(age) };
}

// What gets published: no repo name when the repo is private.
const publicView = (ev) => ev && { ...ev, repo: ev.private ? null : ev.repo };

async function main() {
  if (!wanted.size) throw new Error('ACTIVITY_USERS is empty.');
  const repos = await candidateRepos();
  const best = new Map();
  await scanAll(repos, scanEvents, best);
  if (best.size < wanted.size) await scanAll(repos.slice(0, 5), scanCommits, best);

  const now = Date.now();
  const last = [...best.values()].reduce((a, b) => (newer(b, a) ? b : a), null);
  const activity = {
    generated_at: new Date(now).toISOString(),
    org: ORG,
    repos_scanned: repos.length,
    last: publicView(last),
    by_user: Object.fromEntries([...wanted].map(([login, user]) => [user, publicView(best.get(login)) || null])),
  };

  await mkdir(OUT_DIR, { recursive: true });
  const b = badge(last, now);
  await writeFile(join(OUT_DIR, 'badge.json'), JSON.stringify(b, null, 2) + '\n');
  await writeFile(join(OUT_DIR, 'activity.json'), JSON.stringify(activity, null, 2) + '\n');

  const where = last ? (last.private ? 'a private repo' : last.repo) : '-';
  console.log(`Scanned ${repos.length} repo(s). Badge: "${b.label}: ${b.message}" (by ${last?.actor ?? '-'} on ${where}).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
