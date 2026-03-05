/**
 * DripJobs CEO Dashboard — ClickUp Data Updater
 *
 * Runs every morning at 7 AM EST via GitHub Actions.
 * Reads tasks from ClickUp and writes ../data.json.
 *
 * Required GitHub Secrets (Settings → Secrets → Actions):
 *   CLICKUP_API_TOKEN       — Your ClickUp personal API token
 *                             (Settings → Apps → API Token)
 *   CLICKUP_TEAM_ID         — Your Workspace ID (shown in ClickUp URL)
 *   CLICKUP_FEATURES_LIST_ID — List ID for features / dev tasks
 *   CLICKUP_BUGS_LIST_ID     — List ID for bugs
 *
 * ClickUp Status conventions assumed (update STATUSES below to match yours):
 *   Done statuses:       "complete", "done", "closed"
 *   In-progress statuses: "in progress", "in review", "in qa"
 *   Bug tag:             tasks tagged "bug" in the bugs list
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN   = process.env.CLICKUP_API_TOKEN;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const FEATURES_LIST = process.env.CLICKUP_FEATURES_LIST_ID;
const BUGS_LIST     = process.env.CLICKUP_BUGS_LIST_ID;

// ── DripJobs ClickUp status names ───────────────────────────────────────────
// Active Development: 'pushed to production' = shipped to users
const DONE_STATUSES        = ['pushed to production', 'resolved without fix', 'no fix needed', 'send to dev'];
// Active Development in-flight statuses
const IN_PROGRESS_STATUSES = ['in progress', 'deployed to test', 'testing complete', 'pr created', 'code complete', 'branch ready'];
// Active Triage deferred statuses
const DEFERRED_STATUSES    = ['postponed', 'on hold'];
// ────────────────────────────────────────────────────────────────────────────

if (!TOKEN || !TEAM_ID) {
  console.error('❌ Missing CLICKUP_API_TOKEN or CLICKUP_TEAM_ID. Check GitHub Secrets.');
  process.exit(1);
}

async function clickup(path, params = {}) {
  const url = new URL(`https://api.clickup.com/api/v2${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: TOKEN },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

// Returns Unix timestamp for N days ago
function daysAgo(n) {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

// Returns Unix timestamp for Jan 1 of the current year
function startOfYear() {
  return new Date(new Date().getFullYear(), 0, 1).getTime();
}

// Returns Unix timestamp for Monday 00:00 of the current week
function startOfWeek() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff).getTime();
}

// Returns Unix timestamps for start/end of the previous calendar year
function startOfPrevYear() {
  return new Date(new Date().getFullYear() - 1, 0, 1).getTime();
}
function endOfPrevYear() {
  return new Date(new Date().getFullYear(), 0, 0, 23, 59, 59, 999).getTime();
}

async function getListTasks(listId, extraParams = {}) {
  if (!listId) return [];
  const allTasks = [];
  let page = 0;
  while (true) {
    const data = await clickup(`/list/${listId}/task`, {
      include_closed: true,
      page,
      ...extraParams,
    });
    const tasks = data.tasks || [];
    allTasks.push(...tasks);
    if (tasks.length < 100) break; // ClickUp returns max 100/page; < 100 means last page
    page++;
  }
  return allTasks;
}

function computeStats(featureTasks, bugTasks, sinceMs, untilMs = Date.now()) {
  const status       = t => t.status?.status?.toLowerCase().trim();
  const isDone       = t => DONE_STATUSES.includes(status(t));
  const isInProgress = t => IN_PROGRESS_STATUSES.includes(status(t));
  const closedInRange  = t => isDone(t) && Number(t.date_closed) >= sinceMs && Number(t.date_closed) <= untilMs;
  const createdInRange = t => Number(t.date_created) >= sinceMs && Number(t.date_created) <= untilMs;

  // Features shipped = pushed to production only (not resolved-without-fix)
  const featuresShipped = featureTasks.filter(t =>
    status(t) === 'pushed to production' && Number(t.date_closed) >= sinceMs
  ).length;
  const inProgress  = featureTasks.filter(isInProgress).length;
  const tasksClosed = [...featureTasks, ...bugTasks].filter(closedInRange).length;

  const openBugs     = bugTasks.filter(t => !isDone(t)).length;
  const bugsNew      = bugTasks.filter(createdInRange).length;
  const bugsResolved = bugTasks.filter(closedInRange).length;
  const bugsDeferred = bugTasks.filter(t => DEFERRED_STATUSES.includes(status(t))).length;

  const bugsClosedInRange = bugTasks.filter(closedInRange).length;
  const totalShipped = featuresShipped + bugsClosedInRange;
  const qaPassRate = totalShipped > 0
    ? Math.round((featuresShipped / totalShipped) * 100)
    : 100;

  return {
    stats: { featuresShipped, qaPassRate, inProgress, openBugs, tasksClosed },
    bugs:  { newThisWeek: bugsNew, resolved: bugsResolved, open: openBugs, deferred: bugsDeferred },
  };
}

async function main() {
  console.log('🔄 Fetching ClickUp data…');

  const [allFeatureTasks, allBugTasks] = await Promise.all([
    getListTasks(FEATURES_LIST),
    getListTasks(BUGS_LIST),
  ]);

  console.log(`   Feature tasks fetched : ${allFeatureTasks.length}`);
  console.log(`   Bug tasks fetched     : ${allBugTasks.length}`);

  // Compute stats for every range the dashboard supports
  const now = Date.now();
  const weekStart = startOfWeek();
  const ranges = {
    today:    computeStats(allFeatureTasks, allBugTasks, daysAgo(1)),
    thisWeek: computeStats(allFeatureTasks, allBugTasks, weekStart),
    lastWeek: computeStats(allFeatureTasks, allBugTasks, weekStart - 7 * 86400000, weekStart - 1),
    '7d':     computeStats(allFeatureTasks, allBugTasks, daysAgo(7)),
    '30d':    computeStats(allFeatureTasks, allBugTasks, daysAgo(30)),
    '90d':    computeStats(allFeatureTasks, allBugTasks, daysAgo(90)),
    ytd:      computeStats(allFeatureTasks, allBugTasks, startOfYear()),
    lastYear: computeStats(allFeatureTasks, allBugTasks, startOfPrevYear(), endOfPrevYear()),
    allTime:  computeStats(allFeatureTasks, allBugTasks, 0),
  };

  // ── Full changelog: all shipped tasks for custom date range search ──────────
  const bugTaskIds = new Set(allBugTasks.map(t => t.id));
  const changelog = [...allFeatureTasks, ...allBugTasks]
    .filter(t => t.status?.status?.toLowerCase().trim() === 'pushed to production' && t.date_closed)
    .sort((a, b) => Number(b.date_closed) - Number(a.date_closed))
    .map(t => {
      const date  = new Date(Number(t.date_closed)).toISOString().slice(0, 10);
      const isBug = bugTaskIds.has(t.id);
      const lower = (t.name || '').toLowerCase();
      let type = isBug ? 'fix' : 'feature';
      if (/\b(ux|ui|design|layout|display|modal|button|icon|style)\b/.test(lower))  type = 'ux';
      if (/\b(perf|performance|speed|faster|pagination|load time|optimize)\b/.test(lower)) type = 'perf';
      return { date, title: t.name, area: t.list?.name || 'General', type };
    });

  // ── Recent activity (last 5 completed tasks across both lists) ─────────────
  const recent = [...allFeatureTasks, ...allBugTasks]
    .filter(t => DONE_STATUSES.includes(t.status?.status?.toLowerCase()) && t.date_closed)
    .sort((a, b) => Number(b.date_closed) - Number(a.date_closed))
    .slice(0, 5)
    .map(t => ({
      title: t.name,
      status: t.status?.status,
      closedAt: new Date(Number(t.date_closed)).toISOString(),
      url: t.url,
    }));

  const data = {
    lastUpdated: new Date().toISOString(),
    // Default (7d) stats at the top level for backwards compatibility
    stats: ranges['7d'].stats,
    bugs:  ranges['7d'].bugs,
    // Per-range stats for the date range dropdown
    ranges,
    // Full changelog — all shipped tasks, used by custom date range search
    changelog,
    recentActivity: recent,
  };

  const outPath = resolve(__dirname, '..', 'data.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('✅ data.json updated:');
  Object.entries(ranges).forEach(([range, d]) => {
    console.log(`   [${range.padEnd(8)}] Features: ${d.stats.featuresShipped}, Tasks closed: ${d.stats.tasksClosed}, Bugs open: ${d.stats.openBugs}`);
  });
  console.log(`   Changelog entries written: ${changelog.length}`);
}

main().catch(err => {
  console.error('❌ Update failed:', err.message);
  process.exit(1);
});
