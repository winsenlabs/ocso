repo: winsenlabs/ocso
branch: main
path: docs

## Last sync
date: 2026-09-22T07:40:00Z

### Updated in this project
- Read the full docs set (PRD, domain model, prompts, providers, MCP, human ops, workers, observability, internal agent) — the repo is documentation only, no UI code exists yet to recreate.
- Built six UI mockups for the three roles on the Rho design system (shared/base.css, one.css, charts.css, mock.css + a new shared/ocso.css).
- Control states, worker config fields, provider list, MCP flow and RBAC behaviour all follow the docs rather than invention.

## Screen map
| Screen | Built from |
| --- | --- |
| 01 Conversation workspace.dc.html | docs/09-HUMAN-OPERATIONS-AND-RBAC.md, docs/03-DOMAIN-AND-DATA-MODEL.md, docs/07-CHANNELS-AND-MULTIMODAL.md, docs/08-MCP-TOOLS-AND-AUTH.md |
| 02 Agent overview.dc.html | docs/01-PRODUCT-PRD.md, docs/05-PROMPTS-AND-CACHING.md, docs/11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md, docs/09-HUMAN-OPERATIONS-AND-RBAC.md |
| 03 System control center.dc.html | docs/10-WORKERS-QUEUES-AND-SCALING.md, docs/11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md, docs/06-MODEL-PROVIDERS.md |
| 04 Connections and models.dc.html | docs/06-MODEL-PROVIDERS.md, docs/08-MCP-TOOLS-AND-AUTH.md, docs/07-CHANNELS-AND-MULTIMODAL.md |
| 05 Internal agent.dc.html | docs/12-INTERNAL-OCSO-AGENT.md, docs/09-HUMAN-OPERATIONS-AND-RBAC.md |
| 06 Home.dc.html | docs/11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md, docs/01-PRODUCT-PRD.md |
| OCSONav.dc.html | docs/09-HUMAN-OPERATIONS-AND-RBAC.md (role visibility) |