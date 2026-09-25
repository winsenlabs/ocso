# Installing plugins

OCSO ships with its own channels, model providers, alert destinations and email drivers. A **plugin** is an npm
package that adds more of them: a channel for another messaging app, a model provider OCSO does not ship, an alert
destination such as Opsgenie, an email driver. Plugin authors build them with
[`@winsendotai/ocso-plugin-sdk`](../../packages/ocso-plugin-sdk/README.md). This page is for the operator who runs OCSO
and wants to install one.

## Trust: read this first

**A plugin runs inside the OCSO api and worker processes, with the same access they have.** It can read the process
environment (database URL, secrets master key), reach the network and read files. OCSO checks that a plugin is the
version you pinned and that its contributions are well formed. It does **not** sandbox the plugin's code.

- Install only plugins whose code you trust, as you would any other dependency of your deployment.
- Pin an exact version (OCSO refuses ranges) and review changes before you move the pin.
- Prefer plugins whose source you can read, and install from a registry you control when you can.

## What OCSO does at start-up

The api, the worker and the demo seed each load the plugins listed in two environment variables:

| variable | meaning |
|---|---|
| `OCSO_PLUGINS` | Comma-separated `name@exactVersion` entries, e.g. `@acme/ocso-channel-line@1.2.3,ocso-alerts-opsgenie@0.4.0`. Unset or empty: no installed plugins. |
| `OCSO_PLUGINS_DIR` | The folder the packages are installed in (`<dir>/node_modules/<name>`). Default `/app/plugins`. |

For each entry OCSO:

1. reads `<dir>/node_modules/<name>/package.json` and refuses to start if the package is missing or its version is not
   exactly the pinned one;
2. imports the package (its `exports["."]` import entry) and takes its default export (or a `plugin` export);
3. refuses a plugin built for another plugin API version (`apiVersion` must be `1`), one whose `name` is already used by
   a first-party or another installed plugin, and one that contributes something the plugin API does not offer
   (tool providers and infrastructure drivers are first-party only in v1);
4. registers its contributions with the same checks as OCSO's own (kind patterns, marks, embed hooks, templates,
   webhook segments, alert events, driver names, no kind registered twice) and refuses the plugin if any fails.

Every problem is listed in one `Invalid OCSO plugin configuration (OCSO_PLUGINS)` error and the process exits: a
deployment never runs with a half-loaded plugin list. When it starts, each process logs one line with every plugin and
its version:

```
plugins: first-party @ocso/channels@1.4.0, @ocso/model-providers@1.4.0, …; installed @acme/ocso-channel-line@1.2.3
```

**The api and the worker must run the same list** (the api receives a channel's webhooks, the worker sends its
replies). Set `OCSO_PLUGINS` once and give it to both, and compare their start-up lines after a change. The demo seed
loads the list too.

Tech admins see the running list under **System → Plugins** (`GET /v1/system/plugins`, permission `system.read`):
each plugin, its version, whether it is first-party or installed, and the kinds it contributes. What a plugin
contributes then appears where OCSO's own kinds do: **Integrations → Channels → Add channel**, the model provider form,
the alert destination form, and `EMAIL_DRIVER=<name>` for an email driver.

## Build a derived image

OCSO's images carry no npm packages beyond their own. Build an image on top of each that installs your plugins into
`/app/plugins`. The same `Dockerfile` serves the api and the worker:

```dockerfile
# plugins/Dockerfile
ARG OCSO_IMAGE=ocso/api:1.4.0
FROM ${OCSO_IMAGE}
USER root
# Exact versions only, the same list as OCSO_PLUGINS.
RUN npm install --prefix /app/plugins --omit=dev --no-audit --no-fund \
      @acme/ocso-channel-line@1.2.3 \
      ocso-alerts-opsgenie@0.4.0 \
 && chown -R root:root /app/plugins
USER node
ENV OCSO_PLUGINS=@acme/ocso-channel-line@1.2.3,ocso-alerts-opsgenie@0.4.0
```

```sh
docker build plugins --build-arg OCSO_IMAGE=ocso/api:1.4.0    -t acme/ocso-api:1.4.0-p1
docker build plugins --build-arg OCSO_IMAGE=ocso/worker:1.4.0 -t acme/ocso-worker:1.4.0-p1
```

Notes:

- `npm install --prefix` writes `/app/plugins/package.json`, `package-lock.json` and `node_modules`. Commit a
  `package.json` with exact versions and a lockfile next to the Dockerfile and use `npm ci --prefix /app/plugins` if
  you want reproducible builds.
- The plugin files stay owned by root: the `node` user that runs OCSO can read them, not change them.
- A plugin's own dependencies are installed next to it. A model provider plugin declares `zod` as a peer dependency;
  install the zod major OCSO uses (4) alongside it.
- A private registry works as usual (`--registry`, or an `.npmrc` copied in and removed in the same layer).

## Docker Compose

Point the `api`, `worker` (and, if you run the demo seed, `seed`) services at the derived images in an override file,
and give them the same list. The base `compose.yaml` builds these services from source (`build:`), so the override must
also drop that build: otherwise `docker compose up --build`, or a host where the derived tag is missing, rebuilds the
plain OCSO image under your derived tag, without `/app/plugins`, and api and worker refuse to start
(`… is not installed in /app/plugins`). `!reset` needs Docker Compose 2.24 or later.

```yaml
# compose.plugins.yaml
x-plugins: &plugins
  OCSO_PLUGINS: '@acme/ocso-channel-line@1.2.3,ocso-alerts-opsgenie@0.4.0'

services:
  api:
    image: acme/ocso-api:1.4.0-p1
    build: !reset null
    environment: *plugins
  worker:
    image: acme/ocso-worker:1.4.0-p1
    build: !reset null
    environment: *plugins
  seed: # demo profile only; the seed runs from the api image
    image: acme/ocso-api:1.4.0-p1
    build: !reset null
    environment: *plugins
```

```sh
docker compose -f compose.yaml -f compose.plugins.yaml up -d
docker compose logs api worker | grep 'plugins:'
```

Alternatively, install the plugins into a volume (`npm install --prefix ./ocso-plugins …` on the host) and mount it
read-only at `/app/plugins` in both services. The derived image is preferred: the plugins are then versioned with the
image you deploy.

## Upgrading and removing

- **Upgrade a plugin:** install the new version, change its pin in `OCSO_PLUGINS`, rebuild both images, deploy api and
  worker together. If the installed version and the pin disagree, OCSO refuses to start and says which is which.
- **Upgrade OCSO:** plugins declare the plugin API version they were built for. If OCSO moves to a new plugin API
  version, a plugin built for the old one is refused at start-up with a message naming both versions; install a
  release of the plugin built for the new one.
- **Remove a plugin:** first retire what uses it (channels, model providers, alert destinations of its kinds; switch
  `EMAIL_DRIVER` back), then drop it from `OCSO_PLUGINS` and the image. Rows of a kind no plugin registers any more
  stay in the database but cannot be used until the plugin is back.

## Errors from plugins

Plugins report typed errors with the SDK's `pluginError(category, code, message, details)`. OCSO translates them at
the plugin boundary into its own errors, so a plugin's "authentication failed" reaches a caller as a 401 with the
plugin's code, like OCSO's own. Any other error a plugin throws is treated as an internal error (500) and logged.
