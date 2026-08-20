/// <reference lib="deno.ns" />

const ENV_FILE = ".okf-stack.env";
const GITHUB_KEY_FILE = ".okf-github-app.pem";
const BACKUP_DIR = "backups";
const SERVICES = ["app", "openfga", "rustfs"];
const EXPOSURE_KEYS = new Set([
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "OKF_APP_BIND",
  "OKF_BASE_URL",
  "OKF_STACK_PORTLESS",
]);

function randomHex(length: number) {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function ensureEnvironment() {
  let contents = "";
  try {
    contents = await Deno.readTextFile(ENV_FILE);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const additions = [
    ["OKF_AUTH_SECRET", randomHex(32)],
    ["OKF_OPENFGA_KEY", randomHex(24)],
    ["OKF_S3_ACCESS_KEY", `okf${randomHex(8)}`],
    ["OKF_S3_SECRET_KEY", randomHex(24)],
  ].filter(([name]) =>
    !contents.split("\n").some((line) => line.startsWith(`${name}=`))
  );
  if (!additions.length) return;
  contents = `${contents.trim()}\n${
    additions.map(([name, value]) => `${name}=${value}`).join("\n")
  }\n`;
  await Deno.writeTextFile(ENV_FILE, contents, { mode: 0o600 });
  await Deno.chmod(ENV_FILE, 0o600);
  console.log(`Updated ${ENV_FILE} with local-only credentials.`);
}

async function configureExposure(usePortless: boolean) {
  const contents = await Deno.readTextFile(ENV_FILE);
  const retained = contents.split("\n").filter((line) => {
    const separator = line.indexOf("=");
    return separator < 0 || !EXPOSURE_KEYS.has(line.slice(0, separator));
  }).filter(Boolean);
  const exposure = usePortless
    ? [
      "OKF_APP_BIND=127.0.0.1::8788",
      "OKF_BASE_URL=http://okf-hub.localhost",
      "BETTER_AUTH_TRUSTED_ORIGINS=http://*.okf-hub.localhost",
      "OKF_STACK_PORTLESS=1",
    ]
    : [
      "OKF_APP_BIND=127.0.0.1:8788:8788",
      "OKF_BASE_URL=http://localhost:8788",
      "BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173",
      "OKF_STACK_PORTLESS=0",
    ];
  await Deno.writeTextFile(
    ENV_FILE,
    `${[...retained, ...exposure].join("\n")}\n`,
    {
      mode: 0o600,
    },
  );
  await Deno.chmod(ENV_FILE, 0o600);
}

async function usesPortless() {
  return (await Deno.readTextFile(ENV_FILE)).split("\n").includes(
    "OKF_STACK_PORTLESS=1",
  );
}

async function configureGitHub(
  appId: string | undefined,
  slug: string | undefined,
) {
  if (!appId?.match(/^\d+$/) || !slug?.match(/^[a-z0-9-]+$/)) {
    throw new Error("Usage: stack.ts github <app-id> <app-slug>");
  }
  const secret = (await new Response(Deno.stdin.readable).text()).trim();
  if (secret.length < 32) throw new Error("GitHub webhook secret is too short");
  const privateKey = (await Deno.readTextFile(GITHUB_KEY_FILE)).trim();
  if (!privateKey.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(`${GITHUB_KEY_FILE} is not a GitHub App private key`);
  }
  const names = new Set([
    "OKF_GITHUB_APP_ID",
    "OKF_GITHUB_APP_SLUG",
    "OKF_GITHUB_PRIVATE_KEY",
    "OKF_GITHUB_WEBHOOK_SECRET",
  ]);
  const current = (await Deno.readTextFile(ENV_FILE)).split("\n").filter(
    (line) => !names.has(line.slice(0, line.indexOf("="))),
  );
  const escapedKey = privateKey.replaceAll("\r", "").replaceAll("\n", "\\n");
  const contents = `${current.filter(Boolean).join("\n")}\n${
    [
      `OKF_GITHUB_APP_ID=${appId}`,
      `OKF_GITHUB_APP_SLUG=${slug}`,
      `OKF_GITHUB_PRIVATE_KEY='${escapedKey}'`,
      `OKF_GITHUB_WEBHOOK_SECRET=${secret}`,
    ].join("\n")
  }\n`;
  await Deno.writeTextFile(ENV_FILE, contents, { mode: 0o600 });
  await Deno.chmod(ENV_FILE, 0o600);
  console.log(`Configured ${slug} in ${ENV_FILE}.`);
}

async function docker(args: string[]) {
  const status = await new Deno.Command("docker", {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`docker ${args.join(" ")} failed`);
}

async function dockerOutput(args: string[]) {
  const output = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error(`docker ${args.join(" ")} failed`);
  return new TextDecoder().decode(output.stdout).trim();
}

async function portless(args: string[]) {
  const status = await new Deno.Command("portless", {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`portless ${args.join(" ")} failed`);
}

function compose(args: string[]) {
  return docker(["compose", "--env-file", ENV_FILE, ...args]);
}

function composeOutput(args: string[]) {
  return dockerOutput(["compose", "--env-file", ENV_FILE, ...args]);
}

async function expose() {
  const address = await composeOutput(["port", "app", "8788"]);
  const port = address.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`Could not read app port from ${address}`);
  await portless(["alias", "okf-hub", port]);
  console.log("OKF Hub is ready at http://okf-hub.localhost");
}

async function start(usePortless = false) {
  await compose(["up", "--build", "-d", "--wait", "--wait-timeout", "180"]);
  if (usePortless) return expose();
  console.log("OKF Hub is ready at http://localhost:8788");
}

async function stop() {
  const usePortless = await usesPortless();
  await compose(["down"]);
  if (usePortless) await portless(["alias", "--remove", "okf-hub"]);
}

async function backup() {
  await Deno.mkdir(BACKUP_DIR, { recursive: true });
  const name = `okf-hub-${new Date().toISOString().replaceAll(":", "-")}.tgz`;
  await compose(["stop", ...SERVICES]);
  try {
    await compose(["run", "--rm", "-e", `BACKUP_FILE=${name}`, "backup"]);
  } finally {
    await compose(["up", "-d", "--wait", "--wait-timeout", "180"]);
  }
  console.log(`${BACKUP_DIR}/${name}`);
}

async function restore(path: string | undefined, confirmed: boolean) {
  if (!path || !confirmed) {
    throw new Error("Usage: deno task stack:restore backups/<file>.tgz --yes");
  }
  await Deno.mkdir(BACKUP_DIR, { recursive: true });
  const backupDirectory = await Deno.realPath(BACKUP_DIR);
  const backupPath = await Deno.realPath(path);
  const prefix = `${backupDirectory}/`;
  const name = backupPath.startsWith(prefix)
    ? backupPath.slice(prefix.length)
    : "";
  if (!name || name.includes("/") || !name.endsWith(".tgz")) {
    throw new Error(`Backup must be a .tgz in ${BACKUP_DIR}/`);
  }

  await compose(["stop", ...SERVICES]);
  await compose(["run", "--rm", "-e", `BACKUP_FILE=${name}`, "restore"]);
  await start(await usesPortless());
}

async function main() {
  await ensureEnvironment();
  const [command, path, confirmation] = Deno.args;
  if (command === "up") {
    await configureExposure(false);
    return start();
  }
  if (command === "up-portless") {
    await configureExposure(true);
    return start(true);
  }
  if (command === "down") return stop();
  if (command === "github") return configureGitHub(path, confirmation);
  if (command === "backup") return backup();
  if (command === "restore") return restore(path, confirmation === "--yes");
  throw new Error("Usage: stack.ts up|up-portless|down|github|backup|restore");
}

if (import.meta.main) await main();
