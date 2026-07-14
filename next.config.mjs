const configuredBasePath = process.env.APP_BASE_PATH ?? '';

function normalizeBasePath(basePath) {
  if (!basePath || basePath === '/') {
    return '';
  }

  return `/${String(basePath).replace(/^\/+|\/+$/g, '')}`;
}

const basePath = normalizeBasePath(configuredBasePath);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
