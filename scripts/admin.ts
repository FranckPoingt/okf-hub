/// <reference lib="deno.ns" />

// `deno task admin <command>`: host-operator access recovery. Targets the
// running Docker stack when there is one, otherwise the local OKF_DATA_DIR.
import { admin, stackRunning } from "./stack.ts";

const args = [...Deno.args];
const target = args[0] === "--stack" || args[0] === "--local"
  ? args.shift()
  : await stackRunning()
  ? "--stack"
  : "--local";

try {
  if (target === "--stack") {
    console.error("Using the running OKF Hub stack (app container).");
    await admin(args);
  } else {
    console.error(
      `Using local data in ${Deno.env.get("OKF_DATA_DIR") ?? ".okf-data"}.`,
    );
    await (await import("../server/admin.ts")).main(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  Deno.exit(1);
}
