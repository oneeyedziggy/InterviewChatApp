const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const normalizeBasePath = (basePath: string): string => {
  if (!basePath || basePath === '/') {
    return '';
  }

  const trimmed = basePath.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
};

const normalizePath = (path: string): string => {
  if (!path || path === '/') {
    return '/';
  }

  return path.startsWith('/') ? path : `/${path}`;
};

export const appBasePath = normalizeBasePath(rawBasePath);

export const withBasePath = (path: string): string => {
  const normalizedPath = normalizePath(path);

  if (!appBasePath) {
    return normalizedPath;
  }

  if (normalizedPath === '/') {
    return `${appBasePath}/`;
  }

  return `${appBasePath}${normalizedPath}`;
};

export const apiPath = (path: string): string => {
  const resolvedPath = withBasePath(
    path.startsWith('/api/') ? path : `/api/${path}`,
  );
  if (typeof window === 'undefined') return resolvedPath;
  const serverId = new URLSearchParams(window.location.search)
    .get('server')
    ?.trim();
  return serverId
    ? `${resolvedPath}${resolvedPath.includes('?') ? '&' : '?'}server=${encodeURIComponent(serverId)}`
    : resolvedPath;
};

export const withServerQuery = (path: string, serverId?: string): string => {
  if (!serverId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}server=${encodeURIComponent(serverId)}`;
};

export const websocketPath = (): string => {
  const path = withBasePath('/ws/');
  if (typeof window === 'undefined') return path;
  const serverId = new URLSearchParams(window.location.search)
    .get('server')
    ?.trim();
  return serverId ? `${path}?server=${encodeURIComponent(serverId)}` : path;
};
