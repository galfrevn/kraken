import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { dirname, join } from "path";

interface AuthEntry {
  type: "oauth" | "api";
  access_token: string;
  provider: string;
}

type AuthStore = Record<string, AuthEntry>;

function authFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".kraken", "auth.json");
}

function readStore(): AuthStore {
  const path = authFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AuthStore;
  } catch {
    return {};
  }
}

function writeStore(store: AuthStore): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows doesn't support chmod
  }
}

export function loadAuth(providerId: string): AuthEntry | null {
  const store = readStore();
  return store[providerId] ?? null;
}

export function saveAuth(providerId: string, entry: AuthEntry): void {
  const store = readStore();
  store[providerId] = entry;
  writeStore(store);
}

export function deleteAuth(providerId: string): void {
  const store = readStore();
  delete store[providerId];
  writeStore(store);
}

export function hasAuth(providerId: string): boolean {
  return loadAuth(providerId) !== null;
}
