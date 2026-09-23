# Meridian core — example MCP server

This is a fictional bank's core system ("Meridian core"), exposed as an **external** MCP server. It
exists so OCSO can be demonstrated and tested end to end. It is **not part of OCSO core**; see build
rule §13, "MCP servers remain external".

It is built on `@modelcontextprotocol/server` v2. `createMcpHandler` builds a fresh `McpServer` per
request, so the server is stateless and serves both **2026-07-28** and **2025-era** clients. Express
and `@modelcontextprotocol/node` provide the HTTP layer. All data is deterministic and in memory, and
it matches the OCSO design walkthrough:
- Priya Deshmukh, CIF 88214, card •4417.
- A duplicate ₹12,480 EMI debit on 14 March 2026: `TXN-8841-2289` and `TXN-8841-2290`.
- The first reversal gets reference `RVSL-5521904`.
- Policy `CRD-114` covers fee waivers.

## Tools

| Tool | Kind | Annotations |
|---|---|---|
| `crm.get_customer` | read | readOnly, idempotent |
| `cards.list_transactions` | read (flags duplicate candidates) | readOnly, idempotent |
| `emi.get_schedule` | read | readOnly, idempotent |
| `knowledge.search_policy` | read (small policy KB) | readOnly, idempotent |
| `statements.send_pdf` | write | `idempotentHint: true`, `destructiveHint: false`, openWorld |
| `disputes.raise_case` | write | `destructiveHint: false` |
| `payments.reverse_transaction` | sensitive write, moves money | `destructiveHint: true` |

- **Schemas.** Every tool has zod input and output schemas and returns `structuredContent`, with a
  JSON text copy for older clients.
- **Business-rule failures** return `isError: true`. Examples: unknown customer, an already-reversed
  transaction, an amount above the original.
- **Authorization is the client's job.** OCSO gates sensitive actions; this server enforces only its
  own rules.

**Per-request headers:**
- `Idempotency-Key`: write tools replay the first result for a key and return `replayed: true`
  instead of acting twice.
- `X-OCSO-Customer-Claims`: OCSO sends these only for connections marked trusted. They are ES256 JWTs verified against OCSO's JWKS when `DEMO_CLAIMS_JWKS_URL` is set (HS256 with `DEMO_CLAIMS_SECRET` is accepted for tests).
  Customer-scoped tools then refuse other customers' data. With neither configured, the header is
  ignored. That is a demo convenience; a real system must always verify the claims.

## Run

```bash
# from the repo root (pnpm workspace)
pnpm --filter @ocso-examples/mcp-bank-demo build
DEMO_MCP_TOKEN=$(openssl rand -hex 24) node examples/mcp-bank-demo/dist/main.js
# or without auth:
DEMO_MCP_AUTH=none node examples/mcp-bank-demo/dist/main.js
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `4100` / `0.0.0.0` | Listen address. MCP is at `POST /mcp`; `GET /healthz` needs no auth |
| `DEMO_MCP_AUTH` | `bearer` | `bearer` or `none` |
| `DEMO_MCP_TOKEN` | — | Required in bearer mode, at least 16 characters. It is compared in constant time and never logged |
| `DEMO_CLAIMS_JWKS_URL` | — | OCSO JWKS URL (`<OCSO public URL>/.well-known/jwks.json`) to verify `X-OCSO-Customer-Claims` |
| `DEMO_CLAIMS_ISSUER` | — | Expected claims issuer (OCSO public URL) |
| `DEMO_CLAIMS_SECRET` | — | Optional HS256 secret for `X-OCSO-Customer-Claims` (tests) |
| `DEMO_ALLOWED_HOSTS` | — | Optional comma-separated `Host` allowlist, for DNS-rebinding protection |

**Bearer mode.** A missing or invalid token gets a 401 with `WWW-Authenticate: Bearer`. The server
publishes no RFC 9728 metadata in this mode, so OCSO reports `oauthAvailable: false` and offers
header auth. In OCSO, configure `auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef }`.

**OAuth mode.** `createMeridianApp({ auth: { mode: 'oauth', … } })` can also act as an OAuth
resource server that serves protected-resource metadata. OCSO's tests use this mode against a test
authorization server. The CLI does not expose it.

### Docker

```bash
docker build -f examples/mcp-bank-demo/Dockerfile -t meridian-core-mcp .   # from the repo root
docker run --rm -p 4100:4100 -e DEMO_MCP_TOKEN=<long-random-token> meridian-core-mcp
```

The image is multi-stage: `node:26-alpine`, `pnpm deploy --prod`, running as the non-root `node`
user, with a health check on `/healthz`.

In Docker Compose, the server sits on a private network. Allowlist its service name in OCSO's
`EgressPolicy`, in both `allowedInternalHosts` and `allowInsecureHttpHosts`, and mark the connection
`network: 'INTERNAL'`.

## Tests

The tests live in `packages/mcp/test/` (`demo-server.test.ts`, plus the discovery, OAuth, health and
tool-provider suites). They start this server in-process on ephemeral ports through
`createMeridianApp`.
