import assert from "node:assert/strict";
import { parseSSOConfig } from "./sso-config.ts";

Deno.test("SSO config derives safe Better Auth defaults", async () => {
  const secrets: Record<string, string> = {
    "/run/secrets/oidc": "client-secret\n",
    "/run/secrets/saml-key": "private-key\n",
  };
  const readFile = (path: string) => Promise.resolve(secrets[path]);
  const [oidc] = await parseSSOConfig(
    JSON.stringify({
      providers: [{
        name: "Company SSO",
        providerId: "company-oidc",
        domain: "example.com",
        oidcConfig: {
          issuer: "https://login.example.com",
          clientId: "client-id",
          clientSecretFile: "/run/secrets/oidc",
        },
      }],
    }),
    "https://hub.example.com",
    readFile,
  );
  assert.equal(oidc.type, "oidc");
  assert.equal(oidc.auth.oidcConfig?.pkce, true);
  assert.equal(
    oidc.auth.oidcConfig?.discoveryEndpoint,
    "https://login.example.com/.well-known/openid-configuration",
  );
  assert.equal(oidc.auth.oidcConfig?.clientSecret, "client-secret");
  assert.equal("clientSecretFile" in (oidc.auth.oidcConfig ?? {}), false);

  const [saml] = await parseSSOConfig(
    JSON.stringify({
      providers: [{
        name: "Company SAML",
        providerId: "company-saml",
        domain: "example.com",
        samlConfig: {
          entryPoint: "https://idp.example.com/sso",
          cert: "certificate",
          spMetadata: { privateKeyFile: "/run/secrets/saml-key" },
        },
      }],
    }),
    "https://hub.example.com",
    readFile,
  );
  assert.equal(saml.type, "saml");
  assert.equal(
    saml.auth.samlConfig?.callbackUrl,
    "https://hub.example.com/api/auth/sso/saml2/sp/acs/company-saml",
  );
  assert.equal(saml.auth.samlConfig?.spMetadata.privateKey, "private-key");
  await assert.rejects(
    parseSSOConfig('{"providers":[]}', "https://hub.example.com"),
    /at least one provider/,
  );
});
