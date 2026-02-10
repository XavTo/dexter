# Deploy and Host Dexter with Web UI on Railway

Dexter with Web UI is a financial research agent wrapped in a secure browser dashboard. It runs autonomous analysis on market data, saves detailed run logs, and lets you launch queries and review outputs without a terminal. It can be triggered manually or scheduled with Railway Cron.

## About Hosting Dexter with Web UI

This deployment runs a Bun-based web server that exposes a small dashboard plus an API. You provide LLM and financial data keys via Railway Variables, then start the service with `bun run web`. The UI lets you launch runs, view history, and inspect full tool logs. For persistence, mount a volume at `/app/.dexter` to keep JSONL scratchpads across deploys. For scheduled execution, add a Railway Cron that calls the dashboard’s `/api/run` endpoint using Basic or Bearer auth.

## Common Use Cases

- Daily or weekly market research runs with saved logs
- Team-accessible research dashboard without terminal access
- Automated research triggers via Railway Cron

## Dependencies for Dexter with Web UI Hosting

- Bun runtime (handled by Railway buildpacks)
- An LLM API key (OpenAI, Anthropic, Google, etc.)

### Deployment Dependencies

- Dexter repo and docs: https://github.com/virattt/dexter
- Financial Datasets: https://financialdatasets.ai
- OpenAI API keys: https://platform.openai.com/api-keys
- Exa Search (optional): https://exa.ai

### Implementation Details

**Start Command**
```bash
bun run web
```

**Dashboard API**
- `POST /api/run` (launches a run, returns `runId`)
- `GET /api/runs` (history)
- `GET /api/runs/:id` (details + logs)

**Auth**
- Basic auth by default (`DASHBOARD_USER` + `DASHBOARD_PASSWORD`)
- Bearer token supported (set `DASHBOARD_AUTH_SCHEME=bearer` for cron)

## Environment Variables

### Required
- `DASHBOARD_PASSWORD`  
  Password protecting the dashboard and API.
- One LLM key (choose one):
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_API_KEY`
  - `XAI_API_KEY`
  - `OPENROUTER_API_KEY`
  - `MOONSHOT_API_KEY`
  - `DEEPSEEK_API_KEY`
- `FINANCIAL_DATASETS_API_KEY`  
  Needed for full market data coverage (AAPL/NVDA/MSFT are free without it).

### Optional
- `PORT`  
  Web server port (Railway injects `PORT` automatically).
- `DASHBOARD_USER`  
  Username for Basic auth (if empty, any username is accepted).
- `DEXTER_MODEL`  
  Model ID (default: `gpt-5.2`).
- `DEXTER_PROVIDER`  
  Model provider (default: `openai`).
- `DEXTER_MAX_ITERATIONS`  
  Max agent loop iterations (default: `10`).
- `EXASEARCH_API_KEY`  
  Enables Exa web search.
- `TAVILY_API_KEY`  
  Fallback search provider.
- `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING`  
  Optional tracing (disable if you don’t need it).

## Web UI Overview (Custom)

The added Web UI replaces the terminal experience with a clean dashboard:
- **New run** form to launch a query
- **History** list of previous runs with status
- **Details** pane showing query, answer, errors, and tool logs

Runs are saved to `.dexter/scratchpad/` as JSONL logs for audit and debugging.

## Why Deploy Dexter with Web UI on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Dexter with Web UI on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
