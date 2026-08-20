export type ConnectorCapability = "import" | "embed";

export type ConnectorField = {
  name: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  secret?: boolean;
};

export type ConnectorDefinition = {
  id: string;
  title: string;
  description: string;
  capabilities: ConnectorCapability[];
  fields: ConnectorField[];
  enabledByDefault: boolean;
  enabled?: boolean;
  connectPath?: string;
  setup?: "github-app";
};

export const connectorDefinitions: ConnectorDefinition[] = [
  {
    id: "git",
    title: "Git repository",
    description: "Import a repository-owned OKF folder over HTTPS.",
    capabilities: ["import"],
    enabledByDefault: true,
    connectPath: "/api/sources/repositories",
    setup: "github-app",
    fields: [
      {
        name: "repositoryUrl",
        label: "Repository URL",
        type: "url",
        placeholder: "https://git.example.com/company/knowledge.git",
        required: true,
      },
      {
        name: "folder",
        label: "OKF folder",
        type: "text",
        placeholder: "okf",
        defaultValue: "okf",
        required: true,
      },
      {
        name: "username",
        label: "Username (optional)",
        type: "text",
      },
      {
        name: "token",
        label: "Access token",
        type: "password",
        secret: true,
      },
    ],
  },
  {
    id: "s3",
    title: "S3-compatible storage",
    description: "Import a customer-controlled OKF bundle from object storage.",
    capabilities: ["import"],
    enabledByDefault: true,
    connectPath: "/api/sources/shared",
    fields: [
      {
        name: "endpoint",
        label: "S3 endpoint",
        type: "url",
        placeholder: "https://s3.example.com",
        required: true,
      },
      { name: "bucket", label: "Bucket", type: "text", required: true },
      {
        name: "path",
        label: "OKF path",
        type: "text",
        defaultValue: "okf",
        required: true,
      },
      {
        name: "region",
        label: "Region",
        type: "text",
        defaultValue: "us-east-1",
        required: true,
      },
      {
        name: "accessKey",
        label: "Access key",
        type: "password",
        required: true,
        secret: true,
      },
      {
        name: "secretKey",
        label: "Secret key",
        type: "password",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "notion",
    title: "Notion",
    description: "Import pages shared with a Notion internal integration.",
    capabilities: ["import"],
    enabledByDefault: true,
    connectPath: "/api/sources/notion",
    fields: [{
      name: "token",
      label: "Internal integration token",
      type: "password",
      placeholder: "ntn_…",
      required: true,
      secret: true,
    }],
  },
  {
    id: "miro",
    title: "Miro",
    description: "Render supported Miro board links as read-only previews.",
    capabilities: ["embed"],
    enabledByDefault: true,
    fields: [],
  },
  {
    id: "google-sheets",
    title: "Google Sheets",
    description: "Render supported spreadsheet links as previews.",
    capabilities: ["embed"],
    enabledByDefault: true,
    fields: [],
  },
];
