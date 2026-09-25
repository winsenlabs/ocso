# Web chat host page (example)

A stand-in for your own website. It embeds the OCSO customer web chat with one script tag and, for a
"signed-in" customer, signs a short-lived HS256 token that the page hands to `OcsoWebChat.identify()`.
It uses only Node built-ins, so there is nothing to install.

```bash
OCSO_URL=http://localhost:3000 \
OCSO_WEBCHAT_KEY=<the web chat channel's public key> \
OCSO_HOST_JWT_SECRET=<the channel's host JWT secret, optional> \
node examples/webchat-host/server.mjs      # http://localhost:5440
```

With the Compose demo, the public key is printed by `docker compose logs seed`.

Add this site's origin (`http://localhost:5440`) to the channel's allowed origins, or the chat refuses
to be framed here. On a real site the token endpoint sits behind your own login and uses your customer
id as `sub`. Never send the secret to the browser.

To copy the embed into your own site, take the `<script>` tag from `index.html` and replace
`{{OCSO_URL}}` and `{{WEBCHAT_KEY}}`. For a custom chat UI, see the chat SDK in
[packages/ocso-chat](../../packages/ocso-chat/README.md). The web chat channel is described in
[docs/07-CHANNELS-AND-MULTIMODAL.md](../../docs/07-CHANNELS-AND-MULTIMODAL.md).

This is a demonstration, not hardened code.
