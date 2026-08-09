import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

describe('validateEnv', () => {
  it('rejects an http PocketBase URL in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        POCKETBASE_URL: 'http://pb.example.com',
        NEXT_PUBLIC_POCKETBASE_URL: 'https://pb.example.com',
      } as NodeJS.ProcessEnv)
    ).toThrow(/https/);
  });

  it('rejects a missing PocketBase URL in production', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toThrow(/must be set/);
  });

  it('accepts a valid https config in production', () => {
    const config = validateEnv({
      NODE_ENV: 'production',
      POCKETBASE_URL: 'https://pb.example.com',
      NEXT_PUBLIC_POCKETBASE_URL: 'https://pb.example.com',
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({
      pocketbaseUrl: 'https://pb.example.com',
      publicPocketbaseUrl: 'https://pb.example.com',
    });
  });

  it('falls back to localhost in development without throwing', () => {
    const config = validateEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(config.pocketbaseUrl).toBe('http://127.0.0.1:8090');
  });
});
