const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === '/') {
    return '';
  }

  const trimmed = basePath.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function normalizePath(path: string): string {
  if (!path || path === '/') {
    return '/';
  }

  return path.startsWith('/') ? path : `/${path}`;
}

export const appBasePath = normalizeBasePath(rawBasePath);

export function withBasePath(path: string): string {
  const normalizedPath = normalizePath(path);

  if (!appBasePath) {
    return normalizedPath;
  }

  if (normalizedPath === '/') {
    return `${appBasePath}/`;
  }

  return `${appBasePath}${normalizedPath}`;
}

export function apiPath(path: string): string {
  return withBasePath(path.startsWith('/api/') ? path : `/api/${path}`);
}

export function socketIoPath(): string {
  return withBasePath('/socket.io/');
}
