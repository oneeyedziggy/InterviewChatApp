'use client';

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  MouseEvent as ReactMouseEvent,
  PropsWithChildren,
  ReactNode,
  HTMLAttributes,
} from 'react';
import { Children, useEffect, useRef, useState } from 'react';
import { cn } from '@/utils/cn';

const HORIZONTAL_SPLIT_KEY_LEFT = 'home.layout.leftWidthPct';
const HORIZONTAL_SPLIT_KEY_RIGHT = 'home.layout.rightWidthPct';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function usePersistentNumber(key: string, fallback: number) {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) {
        setValue(parsed);
      } else {
        console.warn('[LayoutHydration] Ignoring non-numeric stored value', {
          key,
          raw,
        });
      }
    } catch (error) {
      console.error('[LayoutHydration] Failed reading localStorage key', {
        key,
        error,
      });
    }
  }, [key]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, String(value));
    } catch (error) {
      console.error('[LayoutHydration] Failed writing localStorage key', {
        key,
        value,
        error,
      });
    }
  }, [key, value]);

  return [value, setValue] as const;
}

export function AppLayoutRow({ children }: PropsWithChildren) {
  const [leftWidthPct, setLeftWidthPct] = usePersistentNumber(
    HORIZONTAL_SPLIT_KEY_LEFT,
    22,
  );
  const [rightWidthPct, setRightWidthPct] = usePersistentNumber(
    HORIZONTAL_SPLIT_KEY_RIGHT,
    24,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const childParts = Children.toArray(children);

  useEffect(() => {
    if (childParts.length !== 3) {
      console.warn(
        '[LayoutHydration] AppLayoutRow expected 3 direct children',
        {
          receivedChildren: childParts.length,
        },
      );
    }
  }, [childParts.length]);

  const startHorizontalResize = (
    side: 'left' | 'right',
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (window.innerWidth < 768) return;
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const nextLeft = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      const nextRight = ((rect.right - moveEvent.clientX) / rect.width) * 100;

      if (side === 'left') {
        const boundedLeft = clamp(nextLeft, 14, 34);
        if (100 - boundedLeft - rightWidthPct >= 32) {
          setLeftWidthPct(boundedLeft);
        }
      } else {
        const boundedRight = clamp(nextRight, 14, 34);
        if (100 - leftWidthPct - boundedRight >= 32) {
          setRightWidthPct(boundedRight);
        }
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const centerWidthPct = 100 - leftWidthPct - rightWidthPct;
  useEffect(() => {
    if (childParts.length !== 3) {
      return;
    }
    if (centerWidthPct < 32) {
      console.warn(
        '[LayoutHydration] Center panel width is below intended minimum',
        {
          leftWidthPct,
          rightWidthPct,
          centerWidthPct,
        },
      );
    }
  }, [childParts.length, centerWidthPct, leftWidthPct, rightWidthPct]);

  useEffect(() => {
    if (childParts.length !== 3) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      console.error('[LayoutHydration] Root element missing after hydration');
      return;
    }

    const verifyLayout = () => {
      const isDesktop = window.matchMedia('(min-width: 768px)').matches;
      const flexDirection = window.getComputedStyle(root).flexDirection;

      if (isDesktop && flexDirection !== 'row') {
        console.error(
          '[LayoutHydration] Desktop viewport but layout is not row',
          {
            viewportWidth: window.innerWidth,
            flexDirection,
          },
        );
      }

      if (!isDesktop && flexDirection !== 'column') {
        console.warn(
          '[LayoutHydration] Mobile viewport but layout is not column',
          {
            viewportWidth: window.innerWidth,
            flexDirection,
          },
        );
      }

      const separators = root.querySelectorAll(
        '[role="separator"][aria-orientation="vertical"]',
      );
      if (isDesktop && separators.length !== 2) {
        console.error(
          '[LayoutHydration] Expected 2 vertical separators in desktop mode',
          {
            found: separators.length,
          },
        );
      }
    };

    const raf = window.requestAnimationFrame(verifyLayout);
    return () => window.cancelAnimationFrame(raf);
  }, [childParts.length, leftWidthPct, rightWidthPct]);

  if (childParts.length !== 3) {
    return (
      <div className="flex min-h-screen flex-col md:flex-row">{children}</div>
    );
  }

  const layoutVars = {
    '--left-panel-width': `${leftWidthPct}%`,
    '--center-panel-width': `${centerWidthPct}%`,
    '--right-panel-width': `${rightWidthPct}%`,
  } as CSSProperties;

  return (
    <div ref={rootRef} className="app-layout-row" style={layoutVars}>
      <div className="app-layout-pane app-layout-pane-left">
        {childParts[0]}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(event) => startHorizontalResize('left', event)}
        className="app-layout-separator app-layout-separator-vertical"
      />
      <div className="app-layout-pane app-layout-pane-center">
        {childParts[1]}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(event) => startHorizontalResize('right', event)}
        className="app-layout-separator app-layout-separator-vertical"
      />
      <div className="app-layout-pane app-layout-pane-right">
        {childParts[2]}
      </div>
    </div>
  );
}

export function SidePanel({ children }: PropsWithChildren) {
  return <aside className="app-side-panel">{children}</aside>;
}

export function MainPanel({ children }: PropsWithChildren) {
  return <section className="app-main-panel">{children}</section>;
}

export function Row({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div {...props} className={cn('app-row', className)}>
      {children}
    </div>
  );
}

type VerticalResizableSectionsProps = {
  storageKey: string;
  top: ReactNode;
  bottom: ReactNode;
  defaultTopSize?: number;
};

export function VerticalResizableSections({
  storageKey,
  top,
  bottom,
  defaultTopSize = 78,
}: VerticalResizableSectionsProps) {
  const [topSize, setTopSize] = usePersistentNumber(storageKey, defaultTopSize);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const startVerticalResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (window.innerWidth < 768) return;
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const nextTop = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setTopSize(clamp(nextTop, 45, 90));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div ref={containerRef} className="app-vertical-sections">
      <div className="app-vertical-top" style={{ height: `${topSize}%` }}>
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={startVerticalResize}
        className="app-layout-separator app-layout-separator-horizontal"
      />
      <div className="app-vertical-bottom">{bottom}</div>
    </div>
  );
}

export function AppTextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('app-text-input', props.className)} />;
}

export function BlockTextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <AppTextInput {...props} className={cn('block', props.className)} />;
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={cn('app-primary-button', props.className)} />
  );
}
