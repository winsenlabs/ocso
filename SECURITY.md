# Security policy

## Reporting a vulnerability

Email **security@winsenlabs.dev**. Please do not open a public GitHub issue, discussion or pull request
for a vulnerability.

Include what you can:

- the affected component (api, worker, web app, a channel or provider adapter, Compose or Terraform
  files) and the commit you tested;
- steps to reproduce, or a proof of concept;
- the impact as you understand it (for example: authentication bypass, a Service member reading another
  team's conversations, a secret appearing in a log or API response, a prompt that makes an agent run
  a tool it should not).

We will acknowledge your report, keep you informed while we investigate and fix it, and credit you in
the release notes if you wish. Please give us reasonable time to release a fix before you disclose
publicly.

Never include real customer data or live credentials in a report. If you find exposed credentials,
tell us which ones without sending the values.

## Supported versions

OCSO is pre-1.0. Only the latest commit on `main` receives security fixes. There are no maintained
release branches yet.

## Scope

OCSO is self-hosted. The project is responsible for the code in this repository. Operators are
responsible for how they run it.

In scope:

- authentication, sessions, MFA, SSO and recovery (`packages/application/src/identity`, the api's
  `AuthGuard`);
- authorization: role permissions, team scoping, conversation access, the public route list;
- tool authorization and confirmation, MCP OAuth and the egress (SSRF) guard;
- channel webhook verification, the web chat visitor and host tokens, signed blob URLs;
- secret handling: the SecretStore, and secrets leaking into logs, traces, prompts, audit records or API
  responses;
- prompt injection that leads to an action OCSO's own checks should have stopped;
- the default Compose configuration and the Terraform in `infra/`.

Out of scope, or the operator's responsibility:

- TLS termination, DNS and the reverse proxy in front of OCSO (Caddy, nginx, a load balancer);
- protecting the host, the Docker daemon, the `secrets` volume and its master key, database backups and
  `.env` files;
- rotating credentials, and choosing and configuring model providers, channel providers and MCP servers;
- vulnerabilities in those third-party services themselves;
- the example applications in `examples/`, which are demonstrations and not hardened;
- denial of service that needs traffic volumes a rate limiter or firewall in front of OCSO would stop;
- findings that require an already-compromised Tech admin account.

The security model is described in [docs/15-SECURITY-AND-GOVERNANCE.md](docs/15-SECURITY-AND-GOVERNANCE.md)
and, for Compose deployments, the hardening advice in
[docs/operations/compose.md](docs/operations/compose.md#6-secret-hardening-for-production).
