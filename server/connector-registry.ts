import type {
  RepositoryCredentials,
  RepositorySnapshot,
} from "./repository-source.ts";
import type { SharedSourceConfig } from "./shared-source.ts";
import type { NotionSourceConfig } from "./notion-source.ts";
import {
  type ConnectorDefinition,
  connectorDefinitions,
} from "../src/lib/connectors.ts";

export type ConnectorRequest =
  | {
    kind: "git";
    checkout: string;
    repositoryUrl: string;
    folder: string;
    credentials?: RepositoryCredentials;
  }
  | { kind: "s3"; config: SharedSourceConfig }
  | { kind: "notion"; config: NotionSourceConfig };

export function createConnectorRegistry(adapters: {
  git: (
    checkout: string,
    repositoryUrl: string,
    folder: string,
    credentials?: RepositoryCredentials,
  ) => Promise<RepositorySnapshot>;
  s3: (config: SharedSourceConfig) => Promise<RepositorySnapshot>;
  notion: (config: NotionSourceConfig) => Promise<RepositorySnapshot>;
}) {
  const definitions = new Map(
    connectorDefinitions.map((definition) => [definition.id, definition]),
  );
  return {
    definitions: connectorDefinitions,
    definition(id: string): ConnectorDefinition | undefined {
      return definitions.get(id);
    },
    sync(request: ConnectorRequest) {
      return request.kind === "git"
        ? adapters.git(
          request.checkout,
          request.repositoryUrl,
          request.folder,
          request.credentials,
        )
        : request.kind === "s3"
        ? adapters.s3(request.config)
        : adapters.notion(request.config);
    },
  };
}
