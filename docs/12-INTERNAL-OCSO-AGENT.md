# Internal OCSO Agent

## 1. Purpose

OCSO includes a built-in internal agent for operating and understanding OCSO itself.

This agent is not a backdoor. It is a conversational interface over the same permissioned application services/control APIs used by the UI.

## 2. Capabilities

Depending on role, it may:
- query conversations
- summarize operational issues
- inspect alerts
- explain agent performance
- inspect provider/tool health
- inspect token/cache usage
- locate failure patterns
- navigate configuration
- propose prompt corrections
- perform approved administrative actions

## 3. RBAC

The internal agent assumes the permissions of the current authenticated user.

Examples:
- CS Exec cannot ask it to reveal platform secrets.
- CS Lead cannot access restricted raw infrastructure controls unless explicitly permitted.
- Tech Admin can inspect technical telemetry.

All agent-issued administrative actions are attributable to the initiating human.

## 4. Read vs write actions

Classify internal-agent tools:
- read
- low-risk write
- high-risk write

Sensitive changes should require explicit confirmation.

Examples:
- "Show worker capacity" — read
- "Acknowledge this alert" — low-risk write
- "Change provider credentials" — sensitive
- "Scale max workers to 100" — sensitive/configurable confirmation

## 5. Architecture

```
Authenticated user
      |
Internal OCSO Agent
      |
Permission/policy layer
      |
Application service APIs
      |
Postgres / telemetry / config / operations
```

Do not give the internal agent direct database superuser access.

## 6. Audit

Persist:
- user
- requested action
- tool/API called
- normalized parameters
- confirmation if required
- result
- timestamp
- correlation ID
