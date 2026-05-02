// Vercel serverless function — Phase 3 substrate endpoint for ChatGPT-Vanta DELTAs
// Deploy: drop this file at api/delta.js in a fresh Vercel project, set GITHUB_PAT env var, deploy.
// Endpoint URL becomes https://YOUR-PROJECT.vercel.app/api/delta — paste that into the Custom GPT OpenAPI schema’s servers field.
//
// Hardening — five invariants enforced:
// (1) Idempotency via deterministic hash + minute timestamp
// (2) State freshness check (409 on stale)
// (3) Atomic-by-filename via GitHub Contents API 422-on-collision
// (4) Required-field validation (8 fields)
// (5) Receipt confirmation: file + commit_sha echoed on success
//
// Logging: every return path goes through respond() which logs a single JSON line to stdout (Vercel captures).
export default async function handler(req, res) {
// CORS for ChatGPT
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
// Closure variables for logging context — populated as the function progresses
let logState = { state_version: null, idempotency_key: null };
// Centralized response helper: logs every return path with consistent shape
const respond = (code, body) => {
try {
console.log(JSON.stringify({
t: new Date().toISOString(),
http: code,
status: body && body.status,
reason: (body && body.reason) || null,
state_version: logState.state_version,
idempotency_key: logState.idempotency_key,
}));
} catch (e) {
// Logging must never block the return
}
return res.status(code).json(body);
};
if (req.method === ‘OPTIONS’) {
return res.status(200).end();
}
if (req.method !== ‘POST’) {
return respond(405, { status: ‘error’, reason: ‘method_not_allowed’, detail: ‘POST required’ });
}
const {
state_version,
state_hash,
owner,
decision,
tags = [],
gate_outcome,
result,
route_match,
tag_compliance,
reason,
full_text,
idempotency_key,
} = req.body || {};
logState.state_version = state_version || null;
// Schema validation — required fields (eight per ChatGPT-Vanta hardening pass 2026-05-02 PM)
if (!state_version) return respond(400, { status: ‘error’, reason: ‘missing state_version’ });
if (!state_hash) return respond(400, { status: ‘error’, reason: ‘missing state_hash’ });
if (!owner) return respond(400, { status: ‘error’, reason: ‘missing owner’ });
if (!decision) return respond(400, { status: ‘error’, reason: ‘missing decision’ });
if (!result) return respond(400, { status: ‘error’, reason: ‘missing result’ });
if (!full_text) return respond(400, { status: ‘error’, reason: ‘missing full_text’ });
if (!route_match) return respond(400, { status: ‘error’, reason: ‘missing route_match’ });
if (!tag_compliance) return respond(400, { status: ‘error’, reason: ‘missing tag_compliance’ });
// OWNER enum (engines with actual endpoint access today)
const validOwners = [‘CLAUDE’, ‘COWORK’, ‘GPT’, ‘BRAD’];
if (!validOwners.includes(owner)) {
return respond(400, {
status: ‘error’,
reason: invalid owner '${owner}' — must be one of: ${validOwners.join(', ')},
});
}
// Idempotency: deterministic key from (state_hash + decision + full_text + minute timestamp)
// Cross-minute slow retries get different keys (rare); within-minute retries dedup correctly (common).
const crypto = await import(‘crypto’);
const minuteStamp = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
const idempKey = idempotency_key && typeof idempotency_key === ‘string’
? idempotency_key
: crypto
.createHash(‘sha256’)
.update(${state\_hash}|${decision}|${full\_text}|${minuteStamp})
.digest(‘hex’)
.slice(0, 16);
logState.idempotency_key = idempKey;
// Build the JSON payload that Cowork-Vanta will read
const timestamp = new Date().toISOString();
const filePayload = {
schema: ‘vanta_phase_2_5_chatgpt_inbox_v1’,
ts: timestamp,
idempotency_key: idempKey,
state_version,
state_hash,
owner,
decision,
tags,
gate_outcome: gate_outcome || ‘PASS’,
result,
route_match,
tag_compliance,
reason: reason || ‘’,
full_text,
};
// Atomic-by-filename: {idempotency_key}.json. GitHub Contents API itself enforces uniqueness.
const filename = chatgpt_inbox/${state\_version}\_${idempKey}.json;
const content = Buffer.from(JSON.stringify(filePayload, null, 2)).toString(‘base64’);
// Push to GitHub via Contents API
const githubPat = process.env.GITHUB_PAT;
if (!githubPat) {
return respond(500, { status: ‘error’, reason: ‘GITHUB_PAT environment variable not set on Vercel deployment’ });
}
const repoOwner = process.env.GITHUB_REPO_OWNER || ‘Vanta-Genesis’;
const repoName = process.env.GITHUB_REPO_NAME || ‘vanta-shared-state’;
const branch = process.env.GITHUB_BRANCH || ‘main’;
// STATE FRESHNESS CHECK (R9 §5 — auto-reject stale state, require rebase). 409 Conflict.
try {
const stateFileUrl = <https://api.github.com/repos/${repoOwner}/${repoName}/contents/vanta_state_public.md?ref=${branch}>;
const stateResponse = await fetch(stateFileUrl, {
headers: {
‘Authorization’: token ${githubPat},
‘Accept’: ‘application/vnd.github+json’,
},
});
if (stateResponse.ok) {
const stateData = await stateResponse.json();
const fileContent = Buffer.from(stateData.content || ‘’, ‘base64’).toString(‘utf-8’);
const hashMatch = fileContent.match(/(?:STATE_HASH:|full SHA:)\s**\s([a-f0-9]{40})/i);
const versionMatch = fileContent.match(/STATE_VERSION:*\s([a-f0-9]{7,})/i);
const currentHash = hashMatch ? hashMatch[1] : null;
const currentVersion = versionMatch ? versionMatch[1] : null;
const submittedHashShort = (state_hash || ‘’).toLowerCase();
const currentHashLower = (currentHash || ‘’).toLowerCase();
const matches = currentHashLower && submittedHashShort && currentHashLower.startsWith(submittedHashShort);
if (currentHash && !matches) {
return respond(409, {
status: ‘error’,
reason: ‘state_version_mismatch’,
expected: currentHash,
expected_short: currentVersion,
received: state_hash,
action: ‘rebase: re-fetch vanta_state_public.md from main and resubmit DELTA with current state_hash’,
});
}
}
} catch (err) {
// Fail-open on state-fetch error. Atomic write still protects integrity.
}
// Atomic write attempt. PUT without sha:
//  - file does not exist → GitHub creates it (201)
//  - file exists → GitHub returns 422 with “sha was not supplied” or similar
// We catch 422 and treat as duplicate.
const githubUrl = <https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filename}>;
const commitMessage = DELTA from ${owner} — ${decision.slice(0, 80)};
try {
const githubResponse = await fetch(githubUrl, {
method: ‘PUT’,
headers: {
‘Authorization’: token ${githubPat},
‘Accept’: ‘application/vnd.github+json’,
‘Content-Type’: ‘application/json’,
},
body: JSON.stringify({
message: commitMessage,
content,
branch,
}),
});
