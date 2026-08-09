// Next.js runs register() once per server runtime at startup (dev, build-time
// SSR check skipped, and production). Used here purely to fail fast on bad
// env config — see src/lib/env.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('@/lib/env');
    validateEnv();
  }
}
