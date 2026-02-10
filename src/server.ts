#!/usr/bin/env bun
import { config } from 'dotenv';
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Agent } from './agent/agent.js';

config({ quiet: true });

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? '';
const DASHBOARD_USER = process.env.DASHBOARD_USER ?? '';
const DEXTER_MODEL = process.env.DEXTER_MODEL;
const DEXTER_PROVIDER = process.env.DEXTER_PROVIDER;
const rawMaxIterations = process.env.DEXTER_MAX_ITERATIONS;
const parsedMaxIterations = rawMaxIterations ? Number.parseInt(rawMaxIterations, 10) : undefined;
const DEXTER_MAX_ITERATIONS = Number.isFinite(parsedMaxIterations) ? parsedMaxIterations : undefined;

const DATA_DIR = '.dexter';
const SCRATCHPAD_DIR = join(DATA_DIR, 'scratchpad');
const RUNS_FILE = join(DATA_DIR, 'runs.jsonl');

const MAX_RESULT_CHARS = 4000;
const MAX_ENTRIES = 200;

if (!DASHBOARD_PASSWORD) {
  console.error('DASHBOARD_PASSWORD is required to start the web server.');
  process.exit(1);
}

type RunStatus = 'running' | 'completed' | 'error' | 'unknown';

interface RunInfo {
  runId: string;
  query: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  answer?: string;
  error?: string;
}

interface RunRecord {
  type: 'run_start' | 'run_end' | 'run_error';
  runId: string;
  query?: string;
  startedAt?: string;
  finishedAt?: string;
  answer?: string;
  error?: string;
}

interface ScratchpadEntry {
  type: 'init' | 'tool_result' | 'thinking';
  timestamp: string;
  content?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

function ensureDataDirs(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(SCRATCHPAD_DIR)) {
    mkdirSync(SCRATCHPAD_DIR, { recursive: true });
  }
}

function appendRun(record: RunRecord): void {
  ensureDataDirs();
  appendFileSync(RUNS_FILE, `${JSON.stringify(record)}\n`);
}

function safeParseJson<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function loadRunIndex(): Map<string, RunInfo> {
  const map = new Map<string, RunInfo>();

  if (existsSync(RUNS_FILE)) {
    const lines = readFileSync(RUNS_FILE, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    for (const line of lines) {
      const record = safeParseJson<RunRecord>(line);
      if (!record?.runId) continue;

      const current = map.get(record.runId) ?? {
        runId: record.runId,
        query: record.query ?? '',
        status: 'running' as RunStatus,
      };

      if (record.type === 'run_start') {
        current.query = record.query ?? current.query;
        current.startedAt = record.startedAt ?? current.startedAt;
        current.status = 'running';
      } else if (record.type === 'run_end') {
        current.finishedAt = record.finishedAt ?? current.finishedAt;
        current.answer = record.answer ?? current.answer;
        current.status = 'completed';
      } else if (record.type === 'run_error') {
        current.finishedAt = record.finishedAt ?? current.finishedAt;
        current.error = record.error ?? current.error;
        current.status = 'error';
      }

      map.set(record.runId, current);
    }
  }

  if (existsSync(SCRATCHPAD_DIR)) {
    const files = readdirSync(SCRATCHPAD_DIR).filter((file) => file.endsWith('.jsonl'));
    for (const file of files) {
      const runId = file.replace(/\.jsonl$/, '');
      if (!map.has(runId)) {
        map.set(runId, { runId, query: '', status: 'unknown' });
      }
    }
  }

  return map;
}

function listRuns(): RunInfo[] {
  const runs = Array.from(loadRunIndex().values());
  runs.sort((a, b) => {
    const aKey = a.startedAt ?? a.runId;
    const bKey = b.startedAt ?? b.runId;
    return bKey.localeCompare(aKey);
  });
  return runs;
}

function buildRunId(): string {
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace('T', '-')
    .replace(/:/g, '');
  const rand = randomUUID().slice(0, 8);
  return `${stamp}_${rand}`;
}

function parseScratchpad(runId: string): ScratchpadEntry[] {
  const filepath = join(SCRATCHPAD_DIR, `${runId}.jsonl`);
  if (!existsSync(filepath)) return [];

  const lines = readFileSync(filepath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim());

  return lines
    .map((line) => safeParseJson<ScratchpadEntry>(line))
    .filter((entry): entry is ScratchpadEntry => Boolean(entry));
}

function formatEntry(entry: ScratchpadEntry) {
  if (entry.type === 'tool_result') {
    const raw = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result);
    const truncated = raw.length > MAX_RESULT_CHARS;
    return {
      type: entry.type,
      timestamp: entry.timestamp,
      toolName: entry.toolName ?? '',
      args: entry.args ?? {},
      result: truncated ? `${raw.slice(0, MAX_RESULT_CHARS)}…` : raw,
      truncated,
    };
  }

  return {
    type: entry.type,
    timestamp: entry.timestamp,
    content: entry.content ?? '',
  };
}

async function runAgent(query: string, runId: string): Promise<void> {
  try {
    const agent = Agent.create({
      model: DEXTER_MODEL,
      modelProvider: DEXTER_PROVIDER,
      maxIterations: DEXTER_MAX_ITERATIONS,
      runId,
    });

    const stream = agent.run(query);
    let finalAnswer = '';

    for await (const event of stream) {
      if (event.type === 'done') {
        finalAnswer = event.answer ?? '';
      }
    }

    appendRun({
      type: 'run_end',
      runId,
      finishedAt: new Date().toISOString(),
      answer: finalAnswer,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    appendRun({
      type: 'run_error',
      runId,
      finishedAt: new Date().toISOString(),
      error: errorMessage,
    });
  }
}

function isAuthorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';

  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const [user, pass] = decoded.split(':');
    if (pass === DASHBOARD_PASSWORD && (!DASHBOARD_USER || user === DASHBOARD_USER)) {
      return true;
    }
  }

  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token === DASHBOARD_PASSWORD) {
      return true;
    }
  }

  return false;
}

function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Dexter Dashboard"' },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function parseQueryFromRequest(req: Request): Promise<string> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    return typeof body.query === 'string' ? body.query : '';
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return params.get('query') ?? '';
  }
  const text = await req.text();
  return text.trim();
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dexter Dashboard</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f3ee;
        --bg-accent: #f4e9dc;
        --card: #ffffff;
        --ink: #1d1b16;
        --muted: #5d544a;
        --accent: #b45a3c;
        --accent-2: #2a9d8f;
        --shadow: 0 24px 60px rgba(29, 27, 22, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(1200px 600px at 10% -10%, #f3d7c6 0%, transparent 60%),
          radial-gradient(900px 600px at 100% 0%, #d9ede9 0%, transparent 55%),
          linear-gradient(180deg, var(--bg), var(--bg-accent));
        min-height: 100vh;
      }

      .page {
        max-width: 1100px;
        margin: 0 auto;
        padding: 48px 24px 80px;
      }

      header {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 32px;
      }

      .title {
        font-family: "Fraunces", "Iowan Old Style", serif;
        font-size: clamp(2rem, 4vw, 3rem);
        letter-spacing: 0.02em;
      }

      .subtitle {
        color: var(--muted);
        font-size: 1rem;
        max-width: 760px;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
        grid-template-areas:
          "form details"
          "history details";
        gap: 20px;
        align-items: start;
      }

      .card {
        background: var(--card);
        border-radius: 20px;
        padding: 20px;
        box-shadow: var(--shadow);
        position: relative;
        overflow: hidden;
      }

      .card::after {
        content: "";
        position: absolute;
        inset: auto -40px -40px auto;
        width: 120px;
        height: 120px;
        background: rgba(180, 90, 60, 0.08);
        border-radius: 40% 60% 60% 40%;
      }

      form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      textarea {
        resize: vertical;
        min-height: 120px;
        padding: 14px;
        border-radius: 14px;
        border: 1px solid #e6ded4;
        font-family: inherit;
        font-size: 1rem;
        background: #fbfaf8;
      }

      button {
        background: var(--accent);
        color: white;
        border: none;
        padding: 12px 18px;
        border-radius: 999px;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 20px rgba(180, 90, 60, 0.25);
      }

      .status {
        font-size: 0.9rem;
        color: var(--muted);
      }

      .runs {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: 440px;
        overflow-y: auto;
        padding: 4px;
        scrollbar-gutter: stable both-edges;
      }

      .run {
        border: 1px solid #eee3d8;
        border-radius: 14px;
        padding: 12px;
        display: grid;
        gap: 6px;
        cursor: pointer;
        background: #fffaf5;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
        animation: fadeInUp 0.4s ease;
      }

      .run:hover {
        border-color: var(--accent);
        box-shadow: 0 10px 18px rgba(29, 27, 22, 0.12);
      }

      .run.selected {
        border-color: var(--accent);
        box-shadow: 0 12px 20px rgba(29, 27, 22, 0.16);
      }

      .run-title {
        font-weight: 600;
      }

      .run-meta {
        color: var(--muted);
        font-size: 0.85rem;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.75rem;
        padding: 4px 10px;
        border-radius: 999px;
        background: #efe7dd;
        color: #6c5a4a;
      }

      .badge.running {
        background: #e7f4f2;
        color: #2a9d8f;
      }

      .badge.completed {
        background: #eef7e8;
        color: #4b7f2b;
      }

      .badge.error {
        background: #fdecea;
        color: #b23c2d;
      }

      .card.form {
        grid-area: form;
      }

      .card.history {
        grid-area: history;
      }

      .card.details {
        grid-area: details;
      }

      .details {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-height: 520px;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .detail-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .detail-actions button {
        background: #efe7dd;
        color: #5d544a;
        border: 1px solid #e3d8cc;
        box-shadow: none;
      }

      .detail-actions button:hover {
        box-shadow: 0 8px 16px rgba(29, 27, 22, 0.12);
      }

      .detail-actions button:active {
        transform: translateY(1px);
      }

      pre {
        background: #101010;
        color: #f6f2eb;
        border-radius: 16px;
        padding: 16px;
        white-space: pre-wrap;
        word-wrap: break-word;
      }

      .details pre {
        flex: 1;
        min-height: 240px;
        max-height: 520px;
        overflow: auto;
      }

      @keyframes fadeInUp {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (max-width: 720px) {
        .page {
          padding: 28px 18px 56px;
        }

        header {
          gap: 8px;
          margin-bottom: 20px;
        }

        .grid {
          grid-template-columns: 1fr;
          grid-template-areas:
            "form"
            "history"
            "details";
        }

        .card {
          padding: 16px;
        }

        textarea {
          min-height: 140px;
        }

        button {
          width: 100%;
        }

        .runs {
          max-height: 320px;
        }

        pre {
          min-height: 180px;
        }

        .details {
          min-height: 420px;
        }

        .detail-actions button {
          flex: 1 1 120px;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header>
        <div class="title">Dexter Dashboard</div>
        <div class="subtitle">
          Launch runs, review outputs, and control Dexter without the terminal.
        </div>
      </header>

      <div class="grid">
        <section class="card form">
          <h2>New run</h2>
          <form id="run-form">
            <textarea id="query" placeholder="Your Dexter query..."></textarea>
            <button type="submit">Start</button>
            <div class="status" id="status">Ready.</div>
          </form>
        </section>

        <section class="card history">
          <h2>History</h2>
          <div class="runs" id="runs"></div>
        </section>

        <section class="card details">
          <div class="detail-header">
            <h2>Details</h2>
            <div class="detail-actions">
              <button type="button" id="copy-details">Copy</button>
              <button type="button" id="export-details">Export</button>
            </div>
          </div>
          <div id="detail-meta" class="status">Select a run.</div>
          <pre id="detail-body"></pre>
        </section>
      </div>
    </div>

    <script>
      const runsEl = document.getElementById('runs');
      const statusEl = document.getElementById('status');
      const queryEl = document.getElementById('query');
      const metaEl = document.getElementById('detail-meta');
      const bodyEl = document.getElementById('detail-body');
      const copyBtn = document.getElementById('copy-details');
      const exportBtn = document.getElementById('export-details');
      let selectedRunId = null;
      let lastRunsPayload = '';

      async function fetchRuns() {
        const res = await fetch('/api/runs', { credentials: 'include' });
        if (!res.ok) {
          statusEl.textContent = 'Failed to load runs.';
          return;
        }
        const runs = await res.json();
        const payload = JSON.stringify(runs);
        if (payload === lastRunsPayload) {
          if (selectedRunId) {
            loadRun(selectedRunId);
          }
          return;
        }
        lastRunsPayload = payload;
        const scrollTop = runsEl.scrollTop;
        renderRuns(runs);
        runsEl.scrollTop = scrollTop;
        if (selectedRunId) {
          loadRun(selectedRunId);
        }
      }

      function renderRuns(runs) {
        runsEl.innerHTML = '';
        runs.forEach((run) => {
          const card = document.createElement('div');
          card.className = 'run';
          card.dataset.runId = run.runId;
          const query = run.query || '(Unknown query)';
          const time = run.startedAt || run.runId;
          const status = run.status || 'unknown';
          const titleEl = document.createElement('div');
          titleEl.className = 'run-title';
          titleEl.textContent = query.slice(0, 120);

          const metaEl = document.createElement('div');
          metaEl.className = 'run-meta';
          metaEl.textContent = time;

          const badgeEl = document.createElement('span');
          badgeEl.className = \`badge \${status}\`;
          badgeEl.textContent = status;

          card.appendChild(titleEl);
          card.appendChild(metaEl);
          card.appendChild(badgeEl);
          if (selectedRunId === run.runId) {
            card.classList.add('selected');
          }
          card.addEventListener('click', () => {
            selectedRunId = run.runId;
            runsEl.querySelectorAll('.run.selected').forEach((el) => el.classList.remove('selected'));
            card.classList.add('selected');
            loadRun(run.runId);
          });
          runsEl.appendChild(card);
        });
      }

      async function loadRun(runId) {
        const res = await fetch(\`/api/runs/\${encodeURIComponent(runId)}\`, { credentials: 'include' });
        if (!res.ok) {
          metaEl.textContent = 'Unable to load this run.';
          bodyEl.textContent = '';
          return;
        }
        const data = await res.json();
        const run = data.run || {};
        metaEl.textContent = \`Run \${run.runId || ''} · \${run.status || ''}\`;
        const parts = [];
        if (run.query) parts.push(\`Query: \${run.query}\`);
        if (run.answer) parts.push(\`\\nAnswer:\\n\${run.answer}\`);
        if (run.error) parts.push(\`\\nError:\\n\${run.error}\`);
        if (data.entries && data.entries.length) {
          parts.push('\\nLogs:');
          data.entries.forEach((entry) => {
            if (entry.type === 'tool_result') {
              parts.push(\`\\n[\${entry.timestamp}] TOOL \${entry.toolName}\\nargs: \${JSON.stringify(entry.args)}\\n\${entry.result}\`);
            } else {
              parts.push(\`\\n[\${entry.timestamp}] \${entry.type.toUpperCase()}\\n\${entry.content || ''}\`);
            }
          });
        }
        bodyEl.textContent = parts.join('\\n');
      }

      async function copyDetails() {
        const text = bodyEl.textContent || '';
        if (!text.trim()) return;
        try {
          await navigator.clipboard.writeText(text);
          statusEl.textContent = 'Details copied to clipboard.';
        } catch {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
          statusEl.textContent = 'Details copied to clipboard.';
        }
      }

      function exportDetails() {
        const text = bodyEl.textContent || '';
        if (!text.trim()) return;
        const filename = selectedRunId ? \`dexter-\${selectedRunId}.txt\` : 'dexter-details.txt';
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }

      document.getElementById('run-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const query = queryEl.value.trim();
        if (!query) return;
        statusEl.textContent = 'Launching run...';
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ query }),
        });
        if (!res.ok) {
          statusEl.textContent = 'Launch failed.';
          return;
        }
        const data = await res.json();
        statusEl.textContent = \`Run started: \${data.runId}\`;
        queryEl.value = '';
        await fetchRuns();
        if (data.runId) {
          selectedRunId = data.runId;
          await loadRun(data.runId);
        }
      });

      copyBtn?.addEventListener('click', copyDetails);
      exportBtn?.addEventListener('click', exportDetails);

      fetchRuns();
      setInterval(fetchRuns, 5000);
    </script>
  </body>
</html>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (!isAuthorized(req)) {
      return unauthorized();
    }

    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      return htmlResponse(DASHBOARD_HTML);
    }

    if (req.method === 'GET' && path === '/health') {
      return jsonResponse({ ok: true });
    }

    if (req.method === 'GET' && path === '/api/runs') {
      return jsonResponse(listRuns());
    }

    if (req.method === 'GET' && path.startsWith('/api/runs/')) {
      const runId = decodeURIComponent(path.replace('/api/runs/', ''));
      const runs = loadRunIndex();
      const run = runs.get(runId);
      if (!run) {
        return jsonResponse({ error: 'Run not found' }, 404);
      }
      const entries = parseScratchpad(runId)
        .slice(-MAX_ENTRIES)
        .map(formatEntry);
      return jsonResponse({ run, entries });
    }

    if (req.method === 'POST' && path === '/api/run') {
      const query = (await parseQueryFromRequest(req)).trim();
      if (!query) {
        return jsonResponse({ error: 'Missing query' }, 400);
      }

      const runId = buildRunId();
      const startedAt = new Date().toISOString();
      appendRun({ type: 'run_start', runId, query, startedAt });

      void runAgent(query, runId);

      return jsonResponse({ runId, status: 'running', startedAt });
    }

    return new Response('Not found', { status: 404 });
  },
});
