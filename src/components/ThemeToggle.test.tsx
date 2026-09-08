import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle, ThemeToggleStretch } from './ThemeToggle';

const installMatchMedia = (matches: boolean) => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let currentMatches = matches;
  const mediaQueryList = {
    get matches() {
      return currentMatches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    addEventListener: vi.fn(
      (event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (event === 'change') listeners.add(listener);
      },
    ),
    removeEventListener: vi.fn(
      (event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (event === 'change') listeners.delete(listener);
      },
    ),
    dispatchEvent: vi.fn(() => true),
    dispatchChange(nextMatches: boolean) {
      currentMatches = nextMatches;
      listeners.forEach((listener) =>
        listener({ matches: nextMatches } as MediaQueryListEvent),
      );
    },
  } as unknown as MediaQueryList & {
    dispatchChange: (nextMatches: boolean) => void;
  };

  window.matchMedia = vi.fn(() => mediaQueryList) as any;
  return mediaQueryList;
};

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-mode');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('applies stored theme and responds to user changes', async () => {
    const user = userEvent.setup();
    localStorage.setItem('chat_theme', 'dark');
    installMatchMedia(true);

    render(<ThemeToggle />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(
      screen.getByRole('button', { name: /use dark theme/i }),
    ).toHaveAttribute('data-active', 'true');

    await user.click(screen.getByRole('button', { name: /use light theme/i }));

    expect(localStorage.getItem('chat_theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('renders the stretch variant with compact mode', () => {
    installMatchMedia(false);
    render(<ThemeToggleStretch compact />);

    expect(screen.getByRole('group', { name: /theme mode/i })).toHaveClass(
      'app-theme-toggle-group--stretch',
    );
    expect(
      screen.getByRole('button', { name: /use system theme/i }),
    ).toBeInTheDocument();
  });
});
