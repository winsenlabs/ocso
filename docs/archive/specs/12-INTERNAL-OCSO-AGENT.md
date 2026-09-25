# Internal OCSO Agent

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [ask-ocso.md](../../concepts/ask-ocso.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

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
- A Service member cannot ask it to reveal platform secrets.
- A Head or Lead cannot access restricted raw infrastructure controls unless explicitly permitted.
- Tech can inspect technical telemetry.

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

## 4a. How it reaches everything (ADR-035)

Ask OCSO sees two tools. `get_tools(purpose)` searches a catalog generated from every API route, filtered to what the
current user may use; `execute_tool(name, args)` runs a read through the real route as that user, or turns a write into
a confirmation card the user must click. Changes under maker–checker ask for a checker and a reason and are submitted
for approval; Ask OCSO never offers bootstrap self-approval. Checkers can review and decide proposals from the drawer.
A deployment setting (`Ask OCSO can make changes`) turns writes off. See PM/research/12-ask-ocso-copilot.md.

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
