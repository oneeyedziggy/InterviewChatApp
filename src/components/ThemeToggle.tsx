import { useEffect, useState } from 'react';

type ThemeMode = 'system' | 'dark' | 'light';
type ResolvedTheme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'chat_theme';

function resolveSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(mode: ThemeMode) {
  const resolved = mode === 'system' ? resolveSystemTheme() : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-mode', mode);
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const initialThemeMode: ThemeMode =
      stored === 'light' || stored === 'dark' || stored === 'system'
        ? stored
        : 'system';

    setThemeMode(initialThemeMode);
    applyTheme(initialThemeMode);
  }, []);

  useEffect(() => {
    if (themeMode !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => applyTheme('system');
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyTheme(mode);
  };

  return (
    <div
      className={`app-theme-toggle-group ${compact ? 'app-theme-toggle-group--compact' : ''}`.trim()}
      role="group"
      aria-label="Theme mode"
    >
      <button
        type="button"
        className="app-theme-toggle-option"
        data-active={themeMode === 'system'}
        onClick={() => setTheme('system')}
        aria-label="Use system theme"
        title="Use system theme"
      >
        System
      </button>
      <button
        type="button"
        className="app-theme-toggle-option"
        data-active={themeMode === 'light'}
        onClick={() => setTheme('light')}
        aria-label="Use light theme"
        title="Use light theme"
      >
        Light
      </button>
      <button
        type="button"
        className="app-theme-toggle-option"
        data-active={themeMode === 'dark'}
        onClick={() => setTheme('dark')}
        aria-label="Use dark theme"
        title="Use dark theme"
      >
        Dark
      </button>
    </div>
  );
}

export function ThemeToggleStretch({ compact = false }: { compact?: boolean }) {
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const initialThemeMode: ThemeMode =
      stored === 'light' || stored === 'dark' || stored === 'system'
        ? stored
        : 'system';

    setThemeMode(initialThemeMode);
    applyTheme(initialThemeMode);
  }, []);

  useEffect(() => {
    if (themeMode !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => applyTheme('system');
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyTheme(mode);
  };

  return (
    <div
      className={`app-theme-toggle-group app-theme-toggle-group--stretch ${compact ? 'app-theme-toggle-group--compact' : ''}`.trim()}
      role="group"
      aria-label="Theme mode"
    >
      <button
        type="button"
        className="app-theme-toggle-option"
        data-active={themeMode === 'system'}
        onClick={() => setTheme('system')}
        aria-label="Use system theme"
        title="Use system theme"
      >
        System
      </button>
      <button
        type="button"
        className="app-theme-toggle-option"
        data-active={themeMode === 'light'}
        onClick={() => setTheme('light')}
        aria-label="Use light theme"
        title="Use light theme"
      >
        Light
      </button>
      <button
        type="button"
        className="app-theme-toggle-option"
        data-active={themeMode === 'dark'}
        onClick={() => setTheme('dark')}
        aria-label="Use dark theme"
        title="Use dark theme"
      >
        Dark
      </button>
    </div>
  );
}
