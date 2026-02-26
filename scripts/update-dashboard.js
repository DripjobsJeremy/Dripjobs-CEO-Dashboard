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

// ── Customize these to match your ClickUp status names ──────────────────────
const DONE_STATUSES        = ['complete', 'done', 'closed', 'shipped'];
const IN_PROGRESS_STATUSES = ['in progress', 'in review', 'in qa', 'dev', 'review'];
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

async function getListTasks(listId, extraParams = {}) {
  if (!listId) return [];
  const data = await clickup(`/list/${listId}/task`, {
    include_closed: true,
    ...extraParams,
  });
  return data.tasks || [];
}

function computeStats(featureTasks, bugTasks, sinceMs) {
  const isDone        = t => DONE_STATUSES.includes(t.status?.status?.toLowerCase());
  const isInProgress  = t => IN_PROGRESS_STATUSES.includes(t.status?.status?.toLowerCase());
  const closedInRange = t => isDone(t) && Number(t.date_closed) >= sinceMs;
  const createdInRange = t => Number(t.date_created) >= sinceMs;

  const featuresShipped = featureTasks.filter(closedInRange).length;
  const inProgress      = featureTasks.filter(isInProgress).length;
  const tasksClosed     = [...featureTasks, ...bugTasks].filter(closedInRange).length;

  const openBugs     = bugTasks.filter(t => !isDone(t)).length;
  const bugsNew      = bugTasks.filter(createdInRange).length;
  const bugsResolved = bugTasks.filter(closedInRange).length;
  const bugsDeferred = bugTasks.filter(t =>
    t.status?.status?.toLowerCase() === 'deferred'
  ).length;

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
  const ranges = {
    today: computeStats(allFeatureTasks, allBugTasks, daysAgo(1)),
    '7d':  computeStats(allFeatureTasks, allBugTasks, daysAgo(7)),
    '30d': computeStats(allFeatureTasks, allBugTasks, daysAgo(30)),
    '90d': computeStats(allFeatureTasks, allBugTasks, daysAgo(90)),
    ytd:   computeStats(allFeatureTasks, allBugTasks, startOfYear()),
  };

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
    // Per-range stats for the date range buttons
    ranges,
    recentActivity: recent,
  };

  const outPath = resolve(__dirname, '..', 'data.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('✅ data.json updated:');
  Object.entries(ranges).forEach(([range, d]) => {
    console.log(`   [${range.padEnd(5)}] Features: ${d.stats.featuresShipped}, Tasks closed: ${d.stats.tasksClosed}, Bugs open: ${d.stats.openBugs}`);
  });
}

main().catch(err => {
  console.error('❌ Update failed:', err.message);
  process.exit(1);
});
