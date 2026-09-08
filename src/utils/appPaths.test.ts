import { afterEach, describe, expect, it, vi } from 'vitest';

describe('appPaths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('normalizes base paths and joins routes', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/chatApp/');
    const appPaths = await import('./appPaths');

    expect(appPaths.appBasePath).toBe('/chatApp');
    expect(appPaths.withBasePath('/')).toBe('/chatApp/');
    expect(appPaths.withBasePath('logout')).toBe('/chatApp/logout');
    expect(appPaths.apiPath('login')).toBe('/chatApp/api/login');
    expect(appPaths.websocketPath()).toBe('/chatApp/ws/');
  });

  it('returns plain routes without a base path', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    const appPaths = await import('./appPaths');

    expect(appPaths.appBasePath).toBe('');
    expect(appPaths.withBasePath('/logout/')).toBe('/logout/');
    expect(appPaths.apiPath('/api/auth')).toBe('/api/auth');
    expect(appPaths.websocketPath()).toBe('/ws/');
  });
});
