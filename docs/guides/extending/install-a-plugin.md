# Install a plugin

OCSO ships its own channels, model providers, alert destinations and email drivers as first-party plugins. An
**installed plugin** is an npm package that adds more of them: a channel for another messaging app, a model
provider OCSO does not ship, an alert destination, an email driver. This guide is for the operator who runs OCSO
and wants to install one. To build a plugin, see [build a channel plugin](build-a-channel-plugin.md) and the
[plugin SDK reference](../../reference/plugin-sdk.md).

The loader is [`packages/bootstrap/src/plugins/loader.ts`](../../../packages/bootstrap/src/plugins/loader.ts); the
checks it runs are in [`validate.ts`](../../../packages/bootstrap/src/plugins/validate.ts) next to it.

> [!WARNING]
> **Trust: read this first.** A plugin runs inside the OCSO api and worker processes, with the same access they
> have. It can read the process environment (the database URL, the secrets master key), reach the network and read
> files. OCSO checks that a plugin is the version you pinned and that its contributions are well formed. It does
> **not** sandbox the plugin's code.
>
> - Install only plugins whose code you trust, as you would any other dependency of your deployment.
> - Pin an exact version (OCSO refuses ranges) and review changes before you move the pin.
> - Prefer plugins whose source you can read, and install from a registry you control when you can.

## What a plugin can add

In plugin API version 1 an installed plugin can contribute exactly four things:

| Contribution | Where it shows up after install |
|---|---|
| `channels` | **Integrations → Channels → Add channel** |
| `modelProviders` | **Integrations → Models → Add provider** |
| `alertDestinations` | **Alerts → Destinations → Add destination** |
| `emailDrivers` | `EMAIL_DRIVER=<name>` in the environment |

Tool providers and infrastructure drivers (blob, secrets, queue, deployment, audit store) are first-party only.
External tools connect through MCP servers, which need no plugin (see [MCP tools](../tools/mcp.md)).

## Prerequisites

- A running OCSO deployment you can rebuild images for. This guide uses Docker Compose; see
  [Docker Compose](../deploy/docker-compose.md).
- The plugin's npm package name and an **exact** version, for example `@acme/ocso-channel-line@1.2.3`.
- A plugin built with `@winsendotai/ocso-plugin-sdk` for plugin API version `1`.
- Docker Compose 2.24 or later (for `!reset` in the override file below).

## How OCSO loads plugins

The api, the worker and the demo seed each read two variables from the raw environment at start-up:

| Variable | Meaning |
|---|---|
| `OCSO_PLUGINS` | Comma-separated `name@exactVersion` entries, for example `@acme/ocso-channel-line@1.2.3,ocso-alerts-opsgenie@0.4.0`. Unset or empty: no installed plugins. |
| `OCSO_PLUGINS_DIR` | The folder the packages are installed in, as `<dir>/node_modules/<name>`. Default `/app/plugins`. |

For each entry, in order, OCSO:

1. **Parses the pin.** The name must be a valid npm package name and the version an exact semver
   (`x.y.z`, optional pre-release or build). Ranges and tags (`^1.2.3`, `latest`) are refused, and a name listed
   twice is refused.
2. **Checks the installed package.** It reads `<dir>/node_modules/<name>/package.json`. The package must exist,
   its `name` must match, and its `version` must equal the pin exactly.
3. **Imports it the way Node's `import()` would.** The entry is `exports["."]` (conditions `node`, `import`,
   `default`), else `main` with Node's legacy lookup, else `index.js`. The entry must exist and, with symlinks
   followed, stay inside the package folder.
4. **Finds the plugin object.** The default export, else a `plugin` named export; for CommonJS,
   `module.exports`, `exports.plugin` or TypeScript's `exports.default`. Whichever declares an `apiVersion` wins.
5. **Checks the envelope.** `apiVersion` must be `1`. The `name` must be non-empty, at most 214 characters, not
   already used by a first-party or earlier installed plugin, and not in the `@ocso/` scope. Internal-only keys
   (`toolProviders`, `blobDrivers`, `secretsDrivers`, `queueDrivers`, `deploymentDrivers`, `auditStoreDrivers`)
   are refused. Each contribution list must be an array of the right shape.
6. **Registers the contributions** in throwaway registries with the same checks OCSO applies to its own plugins:
   kind patterns, marks, embed hooks, templates, webhook segments, alert events, driver names, and no kind
   registered twice across all loaded plugins.

**Fail closed.** Every problem across all entries is collected into one error, and the process exits:

```text
Invalid OCSO plugin configuration (OCSO_PLUGINS):
  - @acme/ocso-channel-line@1.2.3 is not installed in /app/plugins (npm install --prefix /app/plugins @acme/ocso-channel-line@1.2.3)
  - ocso-alerts-opsgenie@0.4.0 is built for plugin API version 2; this OCSO runs plugin API version 1. Install a plugin release for API version 1
```

A deployment never runs with a half-loaded plugin list. When loading succeeds, each process logs one summary line:

```text
plugins: first-party @ocso/channels@<version>, @ocso/model-providers@<version>, …; installed @acme/ocso-channel-line@1.2.3
```

If a plugin's `name` differs from its package name, it is shown as `name (package@version)`.

## Steps

### 1. Build a derived image of the api and the worker

The OCSO images carry no npm packages beyond their own. Build an image on top of each that installs your plugins
into `/app/plugins`. One Dockerfile serves both:

```dockerfile
# plugins/Dockerfile
ARG OCSO_IMAGE=ocso/api:local
FROM ${OCSO_IMAGE}
USER root
# Exact versions only: the same list as OCSO_PLUGINS.
RUN npm install --prefix /app/plugins --omit=dev --no-audit --no-fund \
      @acme/ocso-channel-line@1.2.3 \
      ocso-alerts-opsgenie@0.4.0 \
 && chown -R root:root /app/plugins
USER node
ENV OCSO_PLUGINS=@acme/ocso-channel-line@1.2.3,ocso-alerts-opsgenie@0.4.0
```

```bash
docker build plugins --build-arg OCSO_IMAGE=ocso/api:local    -t acme/ocso-api:local-p1
docker build plugins --build-arg OCSO_IMAGE=ocso/worker:local -t acme/ocso-worker:local-p1
```

Replace `ocso/api:local` with the image you deploy (`${OCSO_IMAGE_PREFIX}/api:${OCSO_VERSION}` in Compose).

Notes:

- `npm install --prefix` writes `/app/plugins/package.json`, `package-lock.json` and `node_modules`. For
  reproducible builds, commit a `package.json` with exact versions and a lockfile next to the Dockerfile and use
  `npm ci --prefix /app/plugins`.
- The plugin files stay owned by root: the `node` user that runs OCSO can read them but not change them.
- A plugin's own dependencies are installed next to it. A model provider plugin declares `zod` as a peer
  dependency; install zod 4 alongside it.
- A private registry works as usual (`--registry`, or an `.npmrc` copied in and removed in the same layer).

### 2. Point Compose at the derived images

The base `compose.yaml` builds the `api`, `worker` and `seed` services from source (`build:`), so the override must
also drop that build. Otherwise `docker compose up --build`, or a host where the derived tag is missing, rebuilds the
plain OCSO image under your derived tag, without `/app/plugins`, and the api and worker refuse to start
(`… is not installed in /app/plugins`).

```yaml
# compose.plugins.yaml
x-plugins: &plugins
  OCSO_PLUGINS: '@acme/ocso-channel-line@1.2.3,ocso-alerts-opsgenie@0.4.0'

services:
  api:
    image: acme/ocso-api:local-p1
    build: !reset null
    environment: *plugins
  worker:
    image: acme/ocso-worker:local-p1
    build: !reset null
    environment: *plugins
  seed: # demo profile only; the seed runs from the api image
    image: acme/ocso-api:local-p1
    build: !reset null
    environment: *plugins
```

```bash
docker compose -f compose.yaml -f compose.plugins.yaml up -d
```

> [!IMPORTANT]
> **The api and the worker must run the same list.** The api receives a channel's webhooks and the worker sends
> its replies. Set `OCSO_PLUGINS` once and give it to both. The demo seed loads the list too.

Alternative: install the plugins into a host folder (`npm install --prefix ./ocso-plugins …`) and mount it
read-only at `/app/plugins` in both services. The derived image is preferred, because the plugins are then
versioned with the image you deploy.

### 3. Use what the plugin adds

A Tech user adds a channel, model provider or notification destination of the new kind in the web app, like any
first-party kind. Adding one is a configuration change that goes through maker–checker like any other. For an email
driver, set `EMAIL_DRIVER=<name>` plus whatever settings the driver documents, and restart the api and worker.

## Verify it works

1. Both processes log the same summary line:

   ```bash
   docker compose logs api worker | grep 'plugins:'
   ```

2. In the web app, open **System** and find the **Plugins** section. It lists each plugin, its version, whether it
   is first-party or installed, and the kinds it contributes. The same list is `GET /v1/system/plugins`
   (permission `system.read`).
3. The new kind appears in the matching **Add** form (for a channel: **Integrations → Channels → Add channel**).

![The System screen](../../assets/screens/system.webp)

## Troubleshooting

| Message (after `Invalid OCSO plugin configuration (OCSO_PLUGINS):`) | Cause and fix |
|---|---|
| `…: pin an exact version (name@x.y.z); ranges and tags are refused` | Use an exact version in `OCSO_PLUGINS`. |
| `… is not installed in /app/plugins (npm install --prefix …)` | The image does not contain the package. Rebuild the derived image, and check the Compose override drops `build:` so the plain image is not used. |
| `… is pinned, but X is installed in …; install the pinned version or change OCSO_PLUGINS` | The installed version and the pin disagree. Make them match. |
| `… is expected in …, but that folder holds package "…"` | The folder under `node_modules/<name>` holds another package. Reinstall. |
| `… could not be loaded: …` | The entry could not be imported (missing file, entry outside the package, a syntax or dependency error). The message names the cause. |
| `… exports no plugin (expected export default definePlugin({...}) or a plugin export)` | The module has no plugin object. |
| `… declares no apiVersion` / `… is built for plugin API version …` | Install a release of the plugin built with `@winsendotai/ocso-plugin-sdk` for API version 1. |
| `… is named …, which is already taken …` / `… the @ocso/ scope is reserved …` | Plugin names must be unique and outside `@ocso/`. |
| `… contributes toolProviders, which installed plugins cannot contribute …` | The plugin uses an internal-only extension point. It cannot be installed on this OCSO. |
| `… has an invalid contribution: …` | A registry refused a contribution (bad kind pattern, a kind another plugin already registered, missing methods). The plugin author can reproduce it with `checkPlugin` from `@winsendotai/ocso-plugin-sdk/testing`, except clashes with other installed plugins. |

Plugins report runtime errors with the SDK's `pluginError(category, code, message, details)`. OCSO translates them
into its own errors at the plugin boundary, so a plugin's `authentication` error reaches callers as a 401 with the
plugin's code. Any other error a plugin throws is treated as an internal error (500) and logged.

## Upgrading and removing

- **Upgrade a plugin:** install the new version, change its pin in `OCSO_PLUGINS`, rebuild both images, and deploy
  the api and worker together. If the installed version and the pin disagree, OCSO refuses to start and says which
  is which.
- **Upgrade OCSO:** rebuild the derived images on the new OCSO images. If OCSO moves to a new plugin API version, a
  plugin built for the old one is refused at start-up with a message naming both versions; install a release built
  for the new one. See [upgrades](../../operations/upgrades.md).
- **Remove a plugin:** first retire what uses it (channels, model providers and notification destinations of its
  kinds; switch `EMAIL_DRIVER` back), then drop it from `OCSO_PLUGINS` and the image. Rows of a kind no plugin
  registers any more stay in the database but cannot be used until the plugin is back.

## Limits and known gaps

- **No sandbox.** Installed plugins run with full trust, in-process.
- **Four contribution types only** in plugin API version 1 (above).
- **No AWS wiring.** The Terraform in `infra/aws/terraform` does not set `OCSO_PLUGINS` or build derived images. On
  ECS, build the derived images yourself, push them, point the task definitions at them and add `OCSO_PLUGINS` to
  both the api and worker task definitions. This path has not been exercised.
- The plugin SDK is not published to npm yet, so third-party plugins today are built from the OCSO repository's
  SDK package.
- The behaviour of rows whose kind is no longer registered (last bullet under removing) is carried over from the
  earlier installing guide and was not re-verified against the code for this page.

## Related

- [Plugin SDK reference](../../reference/plugin-sdk.md)
- [Build a channel plugin](build-a-channel-plugin.md)
- [Plugins concept](../../concepts/plugins.md)
- [Configuration: plugins](../../reference/configuration.md#plugins)
- [Docker Compose](../deploy/docker-compose.md)
- [Upgrades](../../operations/upgrades.md)
