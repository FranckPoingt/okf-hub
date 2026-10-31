/// <reference lib="deno.ns" />

// Host-operator access recovery. These commands need shell or Docker access to
// the server's data directory; none of them is reachable over HTTP.

import { createSecurity, HOST_OPERATOR } from "./security.ts";

type Security = Awaited<ReturnType<typeof createSecurity>>;
type Log = (message: string) => void;

export const USAGE = `Usage: deno task admin [--stack|--local] <command>

  users                                List accounts
  reset-password <email>               Print a temporary password and sign the user out
  make-owner <email>                   Grant workspace owner
  create-owner <email> [--name <name>] Create an owner account with a temporary password
  login-link <email>                   Print a one-time sign-in link (15 minutes)
  setup-url                            Print the first-run setup link while no account exists`;

function account(security: Security, email: string | undefined) {
  if (!email) throw new Error(USAGE);
  const user = security.operator.findUser(email);
  if (!user) throw new Error(`No account uses ${email}`);
  return { id: String(user.id), email: String(user.email) };
}

async function grantOwner(security: Security, userId: string) {
  if (!security.operator.workspaceReady()) return "pending" as const;
  const changed = await security.setOwner(userId, true);
  if (changed) security.audit(HOST_OPERATOR, "owner.granted", `user:${userId}`);
  return changed ? "granted" as const : "unchanged" as const;
}

const PENDING_SETUP =
  "No workspace exists yet: this account creates it, and owns it, at first sign-in.";

export async function runAdmin(
  security: Security,
  args: string[],
  log: Log = console.log,
) {
  const [command, email] = args;
  const nameIndex = args.indexOf("--name");
  const name = nameIndex > 0 ? args[nameIndex + 1] ?? "" : "";
  if (command === "users") {
    const users = security.operator.users();
    if (!users.length) return log("No accounts yet.");
    for (const user of users) {
      log(
        [
          user.email,
          user.name,
          user.owner ? "owner" : "-",
          user.createdAt,
        ].join("\t"),
      );
    }
    return;
  }
  if (command === "reset-password") {
    const user = account(security, email);
    const password = await security.operator.resetPassword(user.id);
    security.audit(HOST_OPERATOR, "password.reset", `user:${user.id}`);
    return log(
      `Temporary password for ${user.email} (shown once; all sessions were signed out and a new password is required at sign-in):\n${password}`,
    );
  }
  if (command === "make-owner") {
    const user = account(security, email);
    const result = await grantOwner(security, user.id);
    return log(
      result === "pending"
        ? PENDING_SETUP
        : result === "granted"
        ? `${user.email} is now a workspace owner.`
        : `${user.email} is already a workspace owner.`,
    );
  }
  if (command === "create-owner") {
    if (!email || email.startsWith("--")) throw new Error(USAGE);
    const userId = await security.operator.createAccount(email, name);
    security.audit(HOST_OPERATOR, "account.created", `user:${userId}`);
    const result = await grantOwner(security, userId);
    const password = await security.operator.resetPassword(userId);
    return log(
      `${result === "pending" ? PENDING_SETUP : "Created workspace owner."}\n` +
        `Temporary password for ${email.trim().toLowerCase()} (shown once; change required at sign-in):\n${password}`,
    );
  }
  if (command === "login-link") {
    const user = account(security, email);
    const url = await security.operator.loginLink(user.email);
    security.audit(HOST_OPERATOR, "login_link.created", `user:${user.id}`);
    return log(
      `One-time sign-in link for ${user.email} (expires in 15 minutes):\n${url}`,
    );
  }
  if (command === "setup-url") {
    const url = security.setupURL();
    if (url) log(`Create the first OKF Hub account: ${url}`);
    return;
  }
  throw new Error(USAGE);
}

// Ensures OKF_BOOTSTRAP_OWNER_EMAIL has an owner account. Never demotes anyone.
export async function bootstrapOwner(
  security: Security,
  email: string,
  log: Log = console.log,
) {
  let userId = String(security.operator.findUser(email)?.id ?? "");
  let changed = false;
  if (!userId) {
    userId = await security.operator.createAccount(email);
    security.audit(HOST_OPERATOR, "account.bootstrapped", `user:${userId}`);
    changed = true;
  }
  if (await grantOwner(security, userId) === "granted") changed = true;
  if (changed) {
    log(
      `Bootstrap owner ${email}: sign in within 15 minutes at ${await security
        .operator.loginLink(
          email,
        )}\nOr run: deno task admin login-link ${email}`,
    );
  }
  return changed;
}

// Server startup: apply the bootstrap owner, then print the setup link if needed.
export async function announceAccess(
  security: Security,
  bootstrapEmail = "",
) {
  if (bootstrapEmail.trim()) {
    try {
      await bootstrapOwner(security, bootstrapEmail.trim());
    } catch (error) {
      console.error(
        `OKF_BOOTSTRAP_OWNER_EMAIL failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  const url = security.setupURL();
  if (url) console.log(`Create the first OKF Hub account: ${url}`);
}

export async function main(args: string[]) {
  const dataDir = Deno.env.get("OKF_DATA_DIR") ?? ".okf-data";
  try {
    await Deno.stat(`${dataDir}/hub.db`);
  } catch {
    throw new Error(
      `No OKF Hub data in ${dataDir}. Start the server first, or set OKF_DATA_DIR.`,
    );
  }
  const port = Deno.env.get("OKF_PORT") ?? Deno.env.get("PORT") ?? "8788";
  const security = await createSecurity({
    dataDir,
    // Same fallback as server/main.ts so printed links match the running server.
    baseURL: Deno.env.get("OKF_BASE_URL") ?? Deno.env.get("PORTLESS_URL") ??
      `http://127.0.0.1:${port}`,
    authSecret: Deno.env.get("OKF_AUTH_SECRET") ?? undefined,
    openfgaURL: Deno.env.get("OKF_OPENFGA_URL") ?? undefined,
    openfgaKey: Deno.env.get("OKF_OPENFGA_KEY") ?? undefined,
    requireSetupToken: true,
  });
  try {
    await runAdmin(security, args);
  } finally {
    security.close();
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
