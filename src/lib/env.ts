// Fail-fast startup config check (called once from src/instrumentation.ts).
// In production, the PocketBase URLs must be explicitly set and https:// —
// no silent fallback to the localhost default, no plaintext prod traffic.

export interface EnvConfig {
  pocketbaseUrl: string;
  publicPocketbaseUrl: string;
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const pocketbaseUrl = env.POCKETBASE_URL || 'http://127.0.0.1:8090';
  const publicPocketbaseUrl = env.NEXT_PUBLIC_POCKETBASE_URL || 'http://127.0.0.1:8090';

  if (env.NODE_ENV === 'production') {
    for (const [name, url] of [
      ['POCKETBASE_URL', pocketbaseUrl],
      ['NEXT_PUBLIC_POCKETBASE_URL', publicPocketbaseUrl],
    ] as const) {
      if (!env[name]) {
        throw new Error(`${name} must be set in production (no localhost fallback).`);
      }
      if (!url.startsWith('https://')) {
        throw new Error(`${name} must be https:// in production (got: ${url})`);
      }
    }
  }

  return { pocketbaseUrl, publicPocketbaseUrl };
}
