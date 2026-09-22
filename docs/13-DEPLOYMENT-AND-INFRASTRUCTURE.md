# Deployment and Infrastructure

## 1. Requirement

The same OCSO codebase must support:
1. single-host deployment using Docker Compose, suitable for one EC2 instance
2. horizontally scalable AWS deployment using ECS Fargate

Do not fork product logic by deployment type.

## 2. Docker Compose profile

Minimum conceptual services:
- `web` — Next.js
- `api` — NestJS API/control plane
- `worker` — one or more NestJS worker processes
- `postgres`
- optional queue/cache service if selected
- optional local S3-compatible storage for development

Production EC2 may use external managed PostgreSQL/S3 while still using Compose for app processes.

Provide:
- `.env.example`
- health checks
- persistent volume guidance
- upgrade/migration instructions
- safe secret guidance
- one-command documented startup

Target:
```bash
docker compose up -d
```

## 3. ECS Fargate profile

Recommended services:
- API service behind ALB
- worker service independently autoscaled
- frontend service or separately hosted Next.js depending deployment policy
- RDS PostgreSQL
- S3
- queue implementation such as SQS
- secret store such as AWS Secrets Manager
- CloudWatch/OpenTelemetry destination

## 4. Worker scaling

Tech Admin controls logical settings through OCSO. Deployment adapter translates those settings into supported infrastructure/autoscaling configuration where enabled.

At minimum expose:
- min workers
- max workers
- target concurrency
- cooldowns

## 5. Database migrations

Migrations must run as an explicit controlled deployment step, not opportunistically from every worker on startup.

## 6. Health endpoints

Separate:
- liveness
- readiness
- dependency health
- worker heartbeat
- provider/MCP health checks

Do not fail global liveness merely because one optional model provider is unhealthy.

## 7. Secrets

Compose:
- environment/file secrets for development
- documented hardened approach for production

AWS:
- prefer Secrets Manager/SSM/KMS-supported storage
- inject references/credentials at runtime

Never commit production secrets.

## 8. Networking

External MCP/tool servers may live:
- inside same VPC
- in private peered network
- on public HTTPS endpoints

Support configurable egress policy. Use TLS for external boundaries.

## 9. Backup/recovery

Document:
- PostgreSQL backup
- object storage durability
- secret/config recovery
- migration rollback/forward strategy
- conversation recovery expectations
