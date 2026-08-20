---
type: Guide
title: Self-hosted SSO
description: Configure invitation-gated OIDC or SAML authentication for OKF Hub.
tags: [okf-hub, authentication, oidc, saml]
status: stable
---

# Self-hosted SSO

OKF Hub uses Better Auth's SSO plugin for static OIDC or SAML providers. SSO
changes how a user proves their identity; workspace access remains invitation
only.

## Configure a provider

1. Copy `config/sso.example.json` to `config/sso.json`.
2. Delete the provider type you do not use and replace its non-secret values.
   Editors use `config/sso.schema.json` for validation and autocomplete.
3. Put the referenced secret or certificate files under `config/private/` and
   restrict their permissions. This directory is ignored by Git.
4. Add this line to `.okf-stack.env`:

   ```dotenv
   OKF_SSO_CONFIG_FILE=/config/sso.json
   ```

5. Rebuild the stack with `deno task stack`.

`config/sso.json`, `config/private/`, and `.okf-stack.env` are ignored by Git.
Keep them in your secure configuration backup. The Docker stack mounts `config/`
read-only, so the example paths work without rebuilding the image.

Docker or Kubernetes secrets can instead be mounted under `/run/secrets`. Point
the corresponding `*File` field at that mounted file; OKF Hub reads the value at
startup and never returns it through the API.

For a native Deno deployment, set `OKF_SSO_CONFIG_FILE` to the host path of the
JSON file. Restart OKF Hub after changing providers.

## OIDC

The minimum OIDC fields are `issuer`, `clientId`, and either `clientSecretFile`
or `clientSecret`. Prefer the file form. OKF Hub enables PKCE and derives the
discovery URL as `<issuer>/.well-known/openid-configuration`. You can override
`discoveryEndpoint`, `scopes`, `mapping`, or the other Better Auth OIDC fields
in `oidcConfig`.

Register this redirect URI with the identity provider:

```text
<OKF_BASE_URL>/api/auth/sso/callback/<providerId>
```

If the provider's discovery origin is rejected, add its HTTPS origin to the
comma-separated `BETTER_AUTH_TRUSTED_ORIGINS` value in `.okf-stack.env`.

## SAML

The minimum SAML fields are the IdP `entryPoint` and either `certFile` or
`cert`. The IdP certificate is public, but a file avoids awkward multiline JSON.
Unless overridden, OKF Hub derives these service-provider values:

```text
Metadata: <OKF_BASE_URL>/api/auth/sso/saml2/sp/metadata?providerId=<providerId>
ACS:      <OKF_BASE_URL>/api/auth/sso/saml2/sp/acs/<providerId>
```

Set the IdP application audience/entity ID to the metadata URL and its
single-sign-on/ACS URL to the ACS URL. Extra Better Auth SAML options, including
attribute `mapping`, signed AuthnRequests, SP keys, and encrypted assertions,
can be added inside `samlConfig`.

For signed AuthnRequests or encrypted assertions, use file-backed fields such as
`spMetadata.privateKeyFile`, `spMetadata.privateKeyPassFile`,
`spMetadata.encPrivateKeyFile`, and `spMetadata.encPrivateKeyPassFile`. The same
file suffixes are supported under `idpMetadata`; top-level `privateKeyFile` and
`decryptionPvkFile` map to Better Auth's corresponding SAML options.

## Invitation flow

The owner first invites the exact IdP email address. The user opens that invite
link and selects the configured SSO provider. Better Auth creates an account
only when the returned email has a pending invitation; the user then accepts the
workspace invitation normally. Existing SSO users can sign in without another
invite.

See the official
[Better Auth SSO documentation](https://better-auth.com/docs/plugins/sso) for
every supported OIDC and SAML option.
