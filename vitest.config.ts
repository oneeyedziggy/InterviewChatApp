import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: [
        'src/components/ConfirmPopover.tsx',
        'src/components/Input.tsx',
        'src/components/home/HomeLeftPanel.tsx',
        'src/components/home/HomeRightPanel.tsx',
        'src/components/styled/ScrollableDiv.ts',
        'src/constants/index.ts',
        'src/utils/appPaths.ts',
        'src/utils/authValidation.ts',
        'src/utils/cn.ts',
        'src/utils/contextMenuEvents.ts',
        'src/utils/crypto/passwordKeyDerivation.ts',
        'src/utils/crypto/privateKeyEnvelope.ts',
        'src/utils/homeSession.ts',
        'src/utils/inPageDialog.ts',
        'src/utils/messages.ts',
        'src/utils/privateKeyBroker.ts',
        'src/utils/socketAuth.ts',
        'src/utils/userSettings.ts',
      ],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/pages/api/**',
        'src/pages/**',
        'src/contexts/**',
        'src/hooks/**',
        'src/components/layout/**',
        'src/components/home/MessageThread.tsx',
        'src/components/home/LayoutPrimitives.tsx',
        'src/server.ts',
        'src/socket.ts',
        'src/cache.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
