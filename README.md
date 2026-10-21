# eMonitor

Multi-tenant server, website, network and log monitoring platform: agents and pull-based checks, incident
management with deduplication and auto-resolution, flexible alert rules and notifications, maintenance windows,
reports and SLOs — deployed natively on Ubuntu (no Docker).

**Stack:** FastAPI · SQLAlchemy 2 · Alembic · Celery + Redis · PostgreSQL · ClickHouse · React 18 + TypeScript +
Vite + Tailwind + TanStack Query + Recharts · stdlib-only Python agent.

```text
backend/     FastAPI app (app/), Alembic migrations, tests, CLI, load test
frontend/    React SPA (see frontend/README.md)
agent/       Linux monitoring agent, install/uninstall scripts, systemd unit
deployment/  systemd units, nginx, Redis/ClickHouse config, install/upgrade/backup/restore scripts
docs/        architecture, API, data model, deployment, security, metrics, agent, load testing, progress
```

## Documentation
| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | components, pipeline, failure modes & recovery |
| [Deployment](docs/DEPLOYMENT.md) | Ubuntu install, HTTPS, firewall, backups, upgrades, troubleshooting |
| [API](docs/API.md) | conventions, endpoint groups, WebSocket, examples (full spec at `/api/v1/docs`) |
| [Data model](docs/DATA_MODEL.md) | PostgreSQL and ClickHouse schemas |
| [Metrics](docs/METRICS.md) | how uptime, MTTD/MTTA/MTTR, SLOs and burn rates are calculated |
| [Security](docs/SECURITY.md) | controls and operator checklist |
| [Agent](docs/AGENT.md) | install, configuration, reliability, upgrade |
| [Load testing](docs/LOAD_TESTING.md) | tool and recorded results |
| [Progress](docs/PROGRESS.md) | checklist, test results, what is and isn't verified |

## Production install
```bash
sudo ./deployment/scripts/install.sh --domain monitor.example.com --admin-email you@example.com
sudo certbot --nginx -d monitor.example.com
```
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — including the note that the scripts have not yet been run on a
real Ubuntu host.

## Development

Requirements: Python 3.12+, Node 20+, PostgreSQL 15+, Redis 7 (optional for single-process dev), ClickHouse
(optional for dev: an in-memory telemetry store can be used).

```bash
cd backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
export EMONITOR_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/emonitor_dev
alembic upgrade head
python -m app.cli bootstrap --email admin@example.com --org-name "Dev" --org-slug dev
python -m app.cli seed-demo        # optional: clearly-labelled demo org with public targets (no fake results)

# Single-process development mode: scheduler/workers inside the API, telemetry in memory (never in production)
EMONITOR_DEV_INLINE_WORKERS=true EMONITOR_TELEMETRY_BACKEND=memory EMONITOR_COOKIE_SECURE=false \
  uvicorn app.main:app --port 8000

cd ../frontend && npm ci && EMONITOR_BACKEND_URL=http://127.0.0.1:8000 npm run dev    # http://localhost:5173
```

Full-stack dev with real services: run Redis and ClickHouse, `python -m app.cli clickhouse-migrate`, then start
`uvicorn app.main:app`, `python -m app.workers.scheduler`, `python -m app.workers.ingest`,
`celery -A app.workers.celery_app worker -Q checks,notifications,rules,maintenance` and
`celery -A app.workers.celery_app beat`.

## Tests
```bash
cd backend && EMONITOR_TEST_DATABASE_URL=postgresql+asyncpg://postgres@localhost:5432/emonitor_test pytest   # 134 tests
python -m pytest agent/tests                                                                               # 12 tests
cd frontend && npm run typecheck && npm run lint && npm test && npm run build                              # 71 tests
ruff check backend/app backend/tests agent    # from backend/: ruff check app tests ../agent
```
Backend tests need a disposable PostgreSQL database (the suite drops and recreates the schema via Alembic).
