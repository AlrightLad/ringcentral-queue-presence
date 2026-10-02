// node src/cli.ts show
// node src/cli.ts plan    --holder-ext 1001
// node src/cli.ts apply   --holder-ext 1001 [--dry-run]
// node src/cli.ts restore --snapshot before.json [--dry-run]
//
// Writes happen only with RC_WRITE_ENABLED=true AND no --dry-run. Every result is printed as
// JSON so it can be kept as the audit record of what the queue looked like before and after.
import { readFileSync } from "node:fs";
import { readConfig } from "./config.ts";
import { QueuePresenceClient } from "./client.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const cmd = process.argv[2] ?? "show";
  const cfg = readConfig();
  const client = new QueuePresenceClient({
    credentials: cfg.credentials, accountId: cfg.accountId, queueId: cfg.queueId,
    protectedMemberIds: cfg.protectedMemberIds, protectedExtensions: cfg.protectedExtensions, writeEnabled: cfg.writeEnabled,
  });
  const dryRun = process.argv.includes("--dry-run");
  const holder = { ext: arg("--holder-ext"), id: arg("--holder-id"), name: arg("--holder-name") };
  let out: unknown;
  if (cmd === "show") out = client.capture(await client.read());
  else if (cmd === "plan") { if (!holder.ext && !holder.id) throw new Error("--holder-ext or --holder-id is required"); out = (await client.plan(holder)).plan; }
  else if (cmd === "apply") { if (!holder.ext && !holder.id) throw new Error("--holder-ext or --holder-id is required"); out = await client.apply(holder, { dryRun }); }
  else if (cmd === "restore") {
    const file = arg("--snapshot");
    if (!file) throw new Error("--snapshot <file.json> is required (the `before` array from an earlier result)");
    out = await client.restore(JSON.parse(readFileSync(file, "utf8")), { dryRun });
  } else throw new Error(`unknown command '${cmd}' (show | plan | apply | restore)`);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
