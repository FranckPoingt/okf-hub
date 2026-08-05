/// <reference lib="deno.ns" />

const ENV_FILE = ".okf-stack.env";
const BACKUP_DIR = "backups";
const SERVICES = ["app", "openfga", "rustfs"];

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

async function docker(args: string[]) {
  const status = await new Deno.Command("docker", {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`docker ${args.join(" ")} failed`);
}

function compose(args: string[]) {
  return docker(["compose", "--env-file", ENV_FILE, ...args]);
}

async function start() {
  await compose(["up", "--build", "-d", "--wait", "--wait-timeout", "180"]);
  console.log("OKF Hub is ready at http://127.0.0.1:8788");
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
  await start();
}

async function main() {
  await ensureEnvironment();
  const [command, path, confirmation] = Deno.args;
  if (command === "up") return start();
  if (command === "down") return compose(["down"]);
  if (command === "backup") return backup();
  if (command === "restore") return restore(path, confirmation === "--yes");
  throw new Error("Usage: stack.ts up|down|backup|restore");
}

if (import.meta.main) await main();
