const core = require("@actions/core");
const github = require("@actions/github");
const minimatch = require("minimatch");

const MARKER = "<!-- reviewer-suggester:v0 -->";

// -------------------- Utilities --------------------

function isBotLogin(login) {
    if (!login) return true;
    const l = login.toLowerCase();
    return login.endsWith("[bot]") || l.includes("bot") || l === "github-actions";
}

function daysAgoISO(days) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return d.toISOString();
}

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// -------------------- PR comment upsert --------------------

async function upsertComment(octokit, { owner, repo, issue_number, body }) {
    const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number,
        per_page: 100
    });

    const existing = comments.data.find((c) => (c.body || "").includes(MARKER));
    if (existing) {
        await octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existing.id,
            body
        });
        return { updated: true, url: existing.html_url };
    } else {
        const created = await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number,
            body
        });
        return { updated: false, url: created.data.html_url };
    }
}

// -------------------- GitHub fetch helpers --------------------

async function listAllPRFiles(octokit, { owner, repo, pull_number, maxFiles }) {
    const files = [];
    let page = 1;
    while (files.length < maxFiles) {
        const resp = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number,
            per_page: 100,
            page
        });
        if (resp.data.length === 0) break;
        for (const f of resp.data) {
            files.push(f.filename);
            if (files.length >= maxFiles) break;
        }
        page += 1;
    }
    return files;
}

async function topCommitAuthorsForPath(octokit, { owner, repo, path, sinceISO, perFileCommitCap = 30 }) {
    const resp = await octokit.rest.repos.listCommits({
        owner,
        repo,
        path,
        since: sinceISO,
        per_page: perFileCommitCap
    });

    const authors = [];
    for (const c of resp.data) {
        const login = c.author?.login || null;
        if (login && !isBotLogin(login)) authors.push(login);
    }
    return authors;
}

// -------------------- CODEOWNERS support --------------------

const CODEOWNERS_CANDIDATE_PATHS = [
    ".github/CODEOWNERS",
    "CODEOWNERS",
    "docs/CODEOWNERS"
];

async function tryFetchFileText(octokit, { owner, repo, path, ref }) {
    try {
        const resp = await octokit.rest.repos.getContent({ owner, repo, path, ref });
        if (!resp.data || Array.isArray(resp.data) || !resp.data.content) return null;
        const buf = Buffer.from(resp.data.content, resp.data.encoding || "base64");
        return buf.toString("utf8");
    } catch {
        return null;
    }
}

/**
 * Minimal CODEOWNERS parser:
 * - ignores comments/blank lines
 * - supports "pattern owner1 owner2"
 * - last match wins (CODEOWNERS semantics)
 */
function parseCodeowners(text) {
    const rules = [];
    if (!text) return rules;

    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;

        // strip inline comments
        const noInline = line.split(/\s+#/)[0].trim();
        if (!noInline) continue;

        const parts = noInline.split(/\s+/).filter(Boolean);
        if (parts.length < 2) continue;

        const pattern = parts[0];
        const owners = parts
            .slice(1)
            .map((o) => o.replace(/^@/, "").trim())
            .filter((o) => o && !isBotLogin(o));

        if (!owners.length) continue;

        rules.push({ pattern, owners });
    }

    return rules;
}

function normalizeCodeownersPattern(pattern) {
    // CODEOWNERS patterns are a bit special. We do a best-effort mapping.
    // - Leading "/" anchors to repo root
    // - Otherwise can match anywhere
    if (pattern.startsWith("/")) return pattern.slice(1);
    return `**/${pattern}`;
}

function ownersForFile(codeownersRules, filePath) {
    if (!codeownersRules.length) return [];
    let matchedOwners = [];

    // last matching rule wins
    for (const r of codeownersRules) {
        const pat = normalizeCodeownersPattern(r.pattern);
        if (minimatch(filePath, pat, { dot: true, nocase: false, matchBase: true })) {
            matchedOwners = r.owners;
        }
    }
    return matchedOwners;
}

// -------------------- Review latency scoring --------------------

async function computeReviewerLatencyHours(octokit, { owner, repo, lookbackDays, maxClosedPRs = 20 }) {
    // Returns Map(login -> median_latency_hours)
    // We sample recently closed PRs to keep API cost bounded.
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const pulls = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: maxClosedPRs
    });

    const perReviewer = new Map(); // login -> [latencyHours...]

    for (const pr of pulls.data) {
        if (!pr.merged_at && !pr.closed_at) continue;

        const createdAt = new Date(pr.created_at);
        if (createdAt < since) continue;

        // Fetch reviews
        let reviewsResp;
        try {
            reviewsResp = await octokit.rest.pulls.listReviews({
                owner,
                repo,
                pull_number: pr.number,
                per_page: 100
            });
        } catch {
            continue;
        }

        // first review per reviewer on that PR
        const firstByUser = new Map(); // login -> Date
        for (const r of reviewsResp.data) {
            const login = r.user?.login;
            if (!login || isBotLogin(login)) continue;
            if (!r.submitted_at) continue;

            const t = new Date(r.submitted_at);
            const existing = firstByUser.get(login);
            if (!existing || t < existing) firstByUser.set(login, t);
        }

        for (const [login, t] of firstByUser.entries()) {
            const hours = (t.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
            if (!Number.isFinite(hours) || hours < 0) continue;
            if (!perReviewer.has(login)) perReviewer.set(login, []);
            perReviewer.get(login).push(hours);
        }
    }

    const out = new Map();
    for (const [login, arr] of perReviewer.entries()) {
        const m = median(arr);
        if (m != null) out.set(login, m);
    }
    return out;
}

function latencyBonusHours(medianHours) {
    // Convert median review latency into a score bonus.
    // Fast reviewers get a stronger bump. Slow reviewers get little/no bump.
    // Tweakable. Keeps things in a small range to avoid dominating.
    if (medianHours == null) return 0;

    if (medianHours <= 4) return 6;
    if (medianHours <= 12) return 4;
    if (medianHours <= 24) return 2;
    if (medianHours <= 48) return 1;
    return 0;
}

// -------------------- Ranking --------------------

function rankCandidates({
                            fileAuthors,
                            prAuthor,
                            codeownersRules,
                            changedFiles,
                            latencyMap,
                            weights
                        }) {
    const scores = new Map();
    const reasons = new Map(); // login -> Set(reason)

    const add = (login, pts, reason) => {
        if (!login || isBotLogin(login)) return;
        if (login === prAuthor) return;

        scores.set(login, (scores.get(login) || 0) + pts);
        if (!reasons.has(login)) reasons.set(login, new Set());
        if (reason) reasons.get(login).add(reason);
    };

    // 1) Commit history signal (existing behavior)
    for (const { authors } of fileAuthors) {
        const max = Math.min(authors.length, 10);
        for (let i = 0; i < max; i++) {
            const login = authors[i];
            const w = Math.max(1, 3 - i); // 3,2,1 then 1...
            add(login, w * weights.commitHistory, "recent commits");
        }
    }

    // 2) CODEOWNERS signal (boost owners of changed files)
    if (weights.codeowners > 0 && codeownersRules.length) {
        const seen = new Set();
        for (const f of changedFiles) {
            const owners = ownersForFile(codeownersRules, f);
            for (const o of owners) {
                if (!o) continue;
                // Avoid awarding infinite points for many files owned by same person
                const key = `${o}::${f}`;
                if (seen.has(key)) continue;
                seen.add(key);
                add(o, weights.codeowners, "CODEOWNERS");
            }
        }
    }

    // 3) Review latency signal (boost fast reviewers)
    if (weights.latency > 0 && latencyMap && latencyMap.size) {
        for (const [login, medHrs] of latencyMap.entries()) {
            const bonus = latencyBonusHours(medHrs) * weights.latency;
            if (bonus > 0) add(login, bonus, `fast reviewer (~${Math.round(medHrs)}h median)`);
        }
    }

    return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([login, score]) => ({
            login,
            score,
            reasons: [...(reasons.get(login) || [])]
        }));
}

// -------------------- Confidence --------------------

function computeConfidence({ ranked, changedFiles, codeownersRules, fileAuthors }) {
    // Heuristic confidence:
    // - more candidates with strong separation => higher
    // - more evidence coverage across files => higher
    const top = ranked[0]?.score || 0;
    const second = ranked[1]?.score || 0;

    // Evidence coverage: how many changed files had any signal (commit history or CODEOWNERS)
    let covered = 0;
    const byFileHasSignal = new Map(changedFiles.map((f) => [f, false]));

    // commit history implies signal per fileAuthors entry (we don’t track paths in this version)
    // best-effort: treat presence of any fileAuthors as some coverage
    if (fileAuthors.length) {
        // approximate coverage: assume at least half files got commit hits if we have many lookups
        const approx = Math.min(changedFiles.length, Math.max(1, Math.floor(fileAuthors.length)));
        covered = Math.max(covered, approx);
    }

    if (codeownersRules.length) {
        for (const f of changedFiles) {
            if (ownersForFile(codeownersRules, f).length) byFileHasSignal.set(f, true);
        }
    }

    const codeownersCovered = [...byFileHasSignal.values()].filter(Boolean).length;
    covered = Math.max(covered, codeownersCovered);

    const coverageRatio = changedFiles.length ? covered / changedFiles.length : 0;

    const separation = top > 0 ? (top - second) / top : 0; // 0..1

    // Simple buckets
    if (top >= 12 && coverageRatio >= 0.5 && separation >= 0.25) return "High";
    if (top >= 6 && coverageRatio >= 0.25) return "Medium";
    return "Low";
}

// -------------------- Comment formatting --------------------

function formatComment({ suggestions, lookbackDays, maxFiles, fileCount, confidence }) {
    const header = `### Reviewer suggestions\n${MARKER}\n\n`;
    const meta =
        `Based on:\n` +
        `- commit history in the last **${lookbackDays} days**\n` +
        `- changed files: **${Math.min(fileCount, maxFiles)}**\n` +
        `- confidence: **${confidence}**\n\n`;

    if (suggestions.length === 0) {
        return (
            header +
            meta +
            "No strong candidates found (not enough history, no CODEOWNERS match, or only bots/author matched).\n"
        );
    }

    const list = suggestions
        .map((s) => {
            const why = s.reasons?.length ? ` — ${s.reasons.join(", ")}` : "";
            return `- @${s.login} (score: ${s.score})${why}`;
        })
        .join("\n");

    const note = `\n\n_Notes: excludes PR author and bots; heuristic-based._\n`;
    return header + meta + list + note;
}

// -------------------- Main --------------------

async function run() {
    try {
        const token = core.getInput("github_token", { required: true });
        const maxReviewers = parseInt(core.getInput("max_reviewers") || "3", 10);
        const lookbackDays = parseInt(core.getInput("lookback_days") || "90", 10);
        const maxFiles = parseInt(core.getInput("max_files") || "50", 10);

        // New feature flags / bounds
        const useCodeowners = (core.getInput("use_codeowners") || "true") !== "false";
        const useLatency = (core.getInput("use_latency") || "true") !== "false";
        const latencyPRs = parseInt(core.getInput("latency_prs") || "20", 10);

        // Weights to keep things from going off the rails
        const weights = {
            commitHistory: 1,     // existing behavior
            codeowners: useCodeowners ? 4 : 0,
            latency: useLatency ? 1 : 0
        };

        const ctx = github.context;
        if (ctx.eventName !== "pull_request" || !ctx.payload.pull_request) {
            core.info("Not a pull_request event; skipping.");
            return;
        }

        const octokit = github.getOctokit(token);
        const { owner, repo } = ctx.repo;
        const pull_number = ctx.payload.pull_request.number;
        const prAuthor = ctx.payload.pull_request.user?.login;
        const prHeadSha = ctx.payload.pull_request.head?.sha;

        core.info(`Analyzing PR #${pull_number} in ${owner}/${repo}`);

        const files = await listAllPRFiles(octokit, { owner, repo, pull_number, maxFiles });
        const sinceISO = daysAgoISO(lookbackDays);

        // --- CODEOWNERS (optional) ---
        let codeownersRules = [];
        if (useCodeowners) {
            // CODEOWNERS should be read from default branch usually; head sha is OK too.
            const ref = prHeadSha || undefined;
            let codeownersText = null;
            for (const p of CODEOWNERS_CANDIDATE_PATHS) {
                codeownersText = await tryFetchFileText(octokit, { owner, repo, path: p, ref });
                if (codeownersText) break;
            }
            codeownersRules = parseCodeowners(codeownersText);
            core.info(`CODEOWNERS rules loaded: ${codeownersRules.length}`);
        }

        // --- Commit history (existing signal) ---
        const fileAuthors = [];
        for (const path of files) {
            try {
                const authors = await topCommitAuthorsForPath(octokit, { owner, repo, path, sinceISO });
                if (authors.length) fileAuthors.push({ path, authors });
            } catch (e) {
                core.warning(`Failed commit lookup for ${path}: ${e?.message || e}`);
            }
        }

        // --- Review latency (optional) ---
        let latencyMap = new Map();
        if (useLatency) {
            try {
                latencyMap = await computeReviewerLatencyHours(octokit, {
                    owner,
                    repo,
                    lookbackDays,
                    maxClosedPRs: clamp(latencyPRs, 5, 50)
                });
                core.info(`Latency entries computed: ${latencyMap.size}`);
            } catch (e) {
                core.warning(`Latency computation failed (continuing): ${e?.message || e}`);
                latencyMap = new Map();
            }
        }

        // Rank + pick
        const ranked = rankCandidates({
            fileAuthors,
            prAuthor,
            codeownersRules,
            changedFiles: files,
            latencyMap,
            weights
        });

        const suggestions = ranked.slice(0, maxReviewers);
        const confidence = computeConfidence({
            ranked,
            changedFiles: files,
            codeownersRules,
            fileAuthors
        });

        const body = formatComment({
            suggestions,
            lookbackDays,
            maxFiles,
            fileCount: files.length,
            confidence
        });

        const res = await upsertComment(octokit, { owner, repo, issue_number: pull_number, body });
        core.info(res.updated ? "Updated existing suggestion comment." : "Created suggestion comment.");
        core.info(`Comment: ${res.url}`);
    } catch (err) {
        core.setFailed(err?.message || String(err));
    }
}

run();