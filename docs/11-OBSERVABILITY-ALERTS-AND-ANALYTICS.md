# Observability, Alerts and Analytics

## 1. Principle

Observability is user-type specific. Do not build one giant dashboard that mixes infrastructure and business metrics.

## 2. Platform Tech Admin view

Technical telemetry:
- service uptime
- API/worker health
- worker count/capacity
- active conversation leases
- queue depth and age
- CPU/memory/network
- model request rate
- time to first token
- end-to-end turn latency
- provider/model error rate
- input/output/reasoning tokens
- prompt-cache reads/writes/hit ratios
- model/provider cost metadata
- MCP/tool connection health
- tool latency/failure
- retries/timeouts
- webhook health
- database health
- traces/logs
- deploy/version metadata

## 3. CS Lead view

Business/agent telemetry:
- conversations by type/channel
- AI containment
- human escalation
- resolution
- first response time
- time to resolution
- SLA breaches
- escalation reasons
- repeated failure topics
- prompt correction candidates
- knowledge/tool gaps
- CSAT or configured satisfaction signal
- sales outcomes/conversion where relevant
- follow-up outcomes
- agent-by-agent trends
- queue/team performance

Avoid claiming a universal "agent quality score" unless its method is explicit and auditable.

## 4. CS Exec view

Operational attention:
- assigned conversations
- pickup queue
- waiting time
- priority
- customer replies
- SLA risk
- handoff requests
- workload

## 5. OpenTelemetry

Instrument the application with OpenTelemetry-compatible traces/metrics/log correlation where practical.

At minimum correlate:
- request
- conversation
- turn
- model request
- tool call
- worker
- alert

Never put secrets/raw credentials in telemetry.

## 6. Alerts

Alerts are first-class entities.

Pipeline:
```
Event/metric
  -> Alert rule
  -> Deduplication/window
  -> Severity
  -> Audience
  -> Delivery
  -> Ack/resolution
```

### Technical examples
- healthy workers below minimum
- queue age too high
- provider failure spike
- MCP server unavailable
- database degraded
- auth failures
- token/cost anomaly
- monthly model spend reaching a budget threshold (`spend_budget_above`, ADR-027): month-to-date spend in the deployment timezone against a USD budget, once per threshold per month, with a month-end projection
- latency SLO breach

### Business examples
- escalation rate spike
- SLA breach
- unusual unresolved volume
- repeated failure intent
- agent response-quality issue
- tool/business action failures
- conversion/outcome anomaly

## 7. Alert delivery

Support pluggable:
- in-app
- email
- Slack/Teams
- webhook
- pager/on-call integration

## 8. Internal OCSO agent

Alerts and observability must be queryable by the internal agent subject to the logged-in user's permissions.
