import type { OIDCConfig, SAMLConfig } from "@better-auth/sso";

type ProviderInput = {
  name?: unknown;
  providerId?: unknown;
  domain?: unknown;
  oidcConfig?: Record<string, unknown>;
  samlConfig?: Record<string, unknown>;
};

type SecretContainer = Record<string, unknown>;

export type ConfiguredSSOProvider = {
  name: string;
  providerId: string;
  type: "oidc" | "saml";
  auth: {
    providerId: string;
    domain: string;
    oidcConfig?: OIDCConfig;
    samlConfig?: SAMLConfig;
  };
};

function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`SSO ${field} is required`);
  }
  return value.trim();
}

function url(value: unknown, field: string) {
  const result = text(value, field);
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error();
    }
  } catch {
    throw new Error(`SSO ${field} must be an HTTPS URL`);
  }
  return result.replace(/\/$/, "");
}

async function secret(
  container: SecretContainer,
  valueField: string,
  fileField: string,
  field: string,
  readFile: (path: string) => Promise<string>,
  required = false,
) {
  const value = container[valueField];
  const path = container[fileField];
  if (value && path) {
    throw new Error(`SSO ${field} must use a value or file, not both`);
  }
  if (path) {
    const file = text(path, `${field} file`);
    try {
      return text(await readFile(file), field);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SSO ")) {
        throw error;
      }
      throw new Error(`Could not read SSO ${field} file: ${file}`);
    }
  }
  if (value || required) return text(value, field);
  return undefined;
}

async function resolveSecretFiles(
  container: SecretContainer,
  fields: string[],
  prefix: string,
  readFile: (path: string) => Promise<string>,
) {
  const result = { ...container };
  for (const field of fields) {
    const fileField = `${field}File`;
    const value = await secret(
      result,
      field,
      fileField,
      `${prefix} ${field}`,
      readFile,
    );
    delete result[fileField];
    if (value !== undefined) result[field] = value;
  }
  return result;
}

export async function parseSSOConfig(
  source: string,
  baseURL: string,
  readFile: (path: string) => Promise<string> = Deno.readTextFile,
) {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("SSO config must be valid JSON");
  }
  const providers = (document as { providers?: unknown })?.providers;
  if (!Array.isArray(providers) || !providers.length) {
    throw new Error("SSO config must contain at least one provider");
  }
  const ids = new Set<string>();
  return await Promise.all(providers.map(async (raw) => {
    const provider = raw as ProviderInput;
    const name = text(provider.name, "provider name");
    const providerId = text(provider.providerId, "providerId");
    const domain = text(provider.domain, "domain");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(providerId)) {
      throw new Error(
        "SSO providerId must use lowercase letters, numbers, or hyphens",
      );
    }
    if (ids.has(providerId)) {
      throw new Error(`Duplicate SSO providerId: ${providerId}`);
    }
    ids.add(providerId);
    if (Boolean(provider.oidcConfig) === Boolean(provider.samlConfig)) {
      throw new Error(
        `SSO provider ${providerId} needs exactly one oidcConfig or samlConfig`,
      );
    }
    if (provider.oidcConfig) {
      const oidc = { ...provider.oidcConfig };
      const issuer = url(oidc.issuer, `${providerId} issuer`);
      const discoveryEndpoint = oidc.discoveryEndpoint
        ? url(
          oidc.discoveryEndpoint,
          `${providerId} discoveryEndpoint`,
        )
        : `${issuer}/.well-known/openid-configuration`;
      const clientSecret = await secret(
        oidc,
        "clientSecret",
        "clientSecretFile",
        `${providerId} clientSecret`,
        readFile,
        true,
      );
      delete oidc.clientSecretFile;
      return {
        name,
        providerId,
        type: "oidc" as const,
        auth: {
          providerId,
          domain,
          oidcConfig: {
            ...oidc,
            issuer,
            discoveryEndpoint,
            clientId: text(
              oidc.clientId,
              `${providerId} clientId`,
            ),
            clientSecret,
            pkce: oidc.pkce !== false,
          } as OIDCConfig,
        },
      };
    }
    const saml = { ...provider.samlConfig! };
    const issuer = saml.issuer
      ? url(saml.issuer, `${providerId} issuer`)
      : `${baseURL}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`;
    const cert = await secret(
      saml,
      "cert",
      "certFile",
      `${providerId} cert`,
      readFile,
      true,
    );
    const spMetadata = await resolveSecretFiles(
      (saml.spMetadata as SecretContainer | undefined) ?? {},
      ["privateKey", "privateKeyPass", "encPrivateKey", "encPrivateKeyPass"],
      `${providerId} spMetadata`,
      readFile,
    );
    const idpMetadata = saml.idpMetadata
      ? await resolveSecretFiles(
        saml.idpMetadata as SecretContainer,
        ["privateKey", "privateKeyPass", "encPrivateKey", "encPrivateKeyPass"],
        `${providerId} idpMetadata`,
        readFile,
      )
      : undefined;
    const topLevelSecrets = await resolveSecretFiles(
      saml,
      ["privateKey", "decryptionPvk"],
      providerId,
      readFile,
    );
    delete topLevelSecrets.certFile;
    return {
      name,
      providerId,
      type: "saml" as const,
      auth: {
        providerId,
        domain,
        samlConfig: {
          ...topLevelSecrets,
          issuer,
          entryPoint: url(saml.entryPoint, `${providerId} entryPoint`),
          cert,
          callbackUrl: saml.callbackUrl
            ? url(saml.callbackUrl, `${providerId} callbackUrl`)
            : `${baseURL}/api/auth/sso/saml2/sp/acs/${providerId}`,
          spMetadata: {
            entityID: issuer,
            ...spMetadata,
          },
          ...(idpMetadata ? { idpMetadata } : {}),
        } as SAMLConfig,
      },
    };
  }));
}
