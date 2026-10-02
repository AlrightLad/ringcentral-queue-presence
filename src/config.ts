import type { Credentials } from "./auth.ts";
import { flagIsOn } from "./presence.ts";

export type Config = {
  credentials: Credentials;
  accountId: string;
  queueId: string;
  protectedMemberIds: string[];
  protectedExtensions: string[];
  writeEnabled: boolean;
};

const list = (v: string | undefined): string[] => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Read configuration from the environment. Account and queue ids have NO default: a lab or a
 * fork carrying real credentials must never write a production queue because half of its
 * configuration was copied. Missing ids are a configuration error, not a default.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v || !v.trim()) throw new Error(`${k} is required and empty — refusing to guess`);
    return v.trim();
  };
  const credentials: Credentials = {
    serverUrl: env.RC_SERVER_URL?.trim() || "https://platform.ringcentral.com",
    clientId: need("RC_CLIENT_ID"),
    clientSecret: need("RC_CLIENT_SECRET"),
    jwt: env.RC_JWT?.trim() || null,
    username: env.RC_USERNAME?.trim() || null,
    extension: env.RC_EXTENSION?.trim() || null,
    password: env.RC_PASSWORD || null,
  };
  if (!credentials.jwt && !(credentials.username && credentials.password)) {
    throw new Error("set RC_JWT, or RC_USERNAME and RC_PASSWORD (RC_EXTENSION optional)");
  }
  return {
    credentials,
    accountId: need("RC_ACCOUNT_ID"),
    queueId: need("RC_QUEUE_ID"),
    protectedMemberIds: list(env.RC_PROTECTED_MEMBER_IDS),
    protectedExtensions: list(env.RC_PROTECTED_EXTENSIONS),
    writeEnabled: flagIsOn(env.RC_WRITE_ENABLED),
  };
}
