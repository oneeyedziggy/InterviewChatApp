'use client';

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  PropsWithChildren,
  HTMLAttributes,
} from 'react';
import {
  Children,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '@/utils/cn';

const HORIZONTAL_SPLIT_KEY_LEFT = 'home.layout.leftWidthPct';
const HORIZONTAL_SPLIT_KEY_RIGHT = 'home.layout.rightWidthPct';
const HORIZONTAL_SEPARATOR_SPACE = 8;
const RIGHT_PANEL_MIN_WIDTH = 200;

const clamp = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value));
};

const getEffectiveSplit = (left: number, right: number, rootWidth: number) => {
  const availableWidth = Math.max(0, rootWidth - HORIZONTAL_SEPARATOR_SPACE);
  const minimumRight =
    availableWidth > 0 ? (RIGHT_PANEL_MIN_WIDTH / availableWidth) * 100 : 14;
  const effectiveRight = clamp(
    right,
    Math.max(14, minimumRight),
    Math.max(34, minimumRight),
  );
  const effectiveLeft = Math.min(
    clamp(left, 14, 34),
    Math.max(0, 68 - effectiveRight),
  );
  return {
    left: effectiveLeft,
    center: Math.max(0, 100 - effectiveLeft - effectiveRight),
    right: effectiveRight,
    availableWidth,
  };
};

type HomeMobileCarouselContextValue = {
  isMobileCarousel: boolean;
  activeSlide: number;
  hasPrev: boolean;
  hasNext: boolean;
  goToSlide: (slide: number) => void;
};

const HomeMobileCarouselContext =
  createContext<HomeMobileCarouselContextValue | null>(null);

const disabledCarouselContextValue: HomeMobileCarouselContextValue = {
  isMobileCarousel: false,
  activeSlide: 1,
  hasPrev: false,
  hasNext: false,
  goToSlide: () => {},
};

export const useHomeMobileCarousel = () => {
  return useContext(HomeMobileCarouselContext) ?? disabledCarouselContextValue;
};

type MobilePanelHeaderProps = {
  title: ReactNode;
  previousSlide?: number;
  nextSlide?: number;
};

export const MobilePanelHeader = ({
  title,
  previousSlide,
  nextSlide,
}: MobilePanelHeaderProps) => {
  const { isMobileCarousel, goToSlide } = useHomeMobileCarousel();

  if (!isMobileCarousel) {
    return null;
  }

  return (
    <div className="app-mobile-panel-header">
      {typeof previousSlide === 'number' ? (
        <button
          type="button"
          className="app-mobile-panel-nav-button"
          aria-label="Previous panel"
          onClick={() => goToSlide(previousSlide)}
        >
          <span aria-hidden="true">←</span>
        </button>
      ) : (
        <span aria-hidden="true" className="app-mobile-panel-nav-spacer" />
      )}
      <div className="app-mobile-panel-title">{title}</div>
      {typeof nextSlide === 'number' ? (
        <button
          type="button"
          className="app-mobile-panel-nav-button"
          aria-label="Next panel"
          onClick={() => goToSlide(nextSlide)}
        >
          <span aria-hidden="true">→</span>
        </button>
      ) : (
        <span aria-hidden="true" className="app-mobile-panel-nav-spacer" />
      )}
    </div>
  );
};

const usePersistentNumber = (key: string, fallback: number) => {
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
};

export const AppLayoutRow = ({ children }: PropsWithChildren) => {
  const [leftWidthPct, setLeftWidthPct] = usePersistentNumber(
    HORIZONTAL_SPLIT_KEY_LEFT,
    22,
  );
  const [rightWidthPct, setRightWidthPct] = usePersistentNumber(
    HORIZONTAL_SPLIT_KEY_RIGHT,
    24,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const childParts = Children.toArray(children);
  const mobileActiveSlideRef = useRef(1);
  const mobileScrollRafRef = useRef<number | null>(null);
  const mobileDragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    dragging: boolean;
  } | null>(null);
  const [isMobileCarousel, setIsMobileCarousel] = useState(false);
  const [hasMobilePrev, setHasMobilePrev] = useState(false);
  const [hasMobileNext, setHasMobileNext] = useState(false);
  const [mobileActiveSlide, setMobileActiveSlide] = useState(1);
  const [isCarouselDragging, setIsCarouselDragging] = useState(false);
  const carouselHintId = 'home-panels-carousel-hint';

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measureRoot = () => setRootWidth(root.getBoundingClientRect().width);
    measureRoot();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measureRoot);
    observer?.observe(root);
    window.addEventListener('resize', measureRoot);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureRoot);
    };
  }, [childParts.length]);

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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const updateMobileMode = () => {
      setIsMobileCarousel(mediaQuery.matches);
    };

    updateMobileMode();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateMobileMode);
      return () => mediaQuery.removeEventListener('change', updateMobileMode);
    }

    mediaQuery.addListener(updateMobileMode);
    return () => mediaQuery.removeListener(updateMobileMode);
  }, []);

  useEffect(() => {
    if (!isMobileCarousel || childParts.length !== 3) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    const syncCarouselState = () => {
      const { scrollLeft, clientWidth, scrollWidth } = root;
      const slideWidth = clientWidth || 1;
      const activeSlide = clamp(Math.round(scrollLeft / slideWidth), 0, 2);
      mobileActiveSlideRef.current = activeSlide;
      setMobileActiveSlide(activeSlide);
      setHasMobilePrev(scrollLeft > 4);
      setHasMobileNext(scrollLeft + clientWidth < scrollWidth - 4);
    };

    const snapToActiveSlide = () => {
      root.scrollTo({
        left: mobileActiveSlideRef.current * root.clientWidth,
        behavior: 'auto',
      });
      syncCarouselState();
    };

    const onScroll = () => {
      if (mobileScrollRafRef.current !== null) {
        window.cancelAnimationFrame(mobileScrollRafRef.current);
      }

      mobileScrollRafRef.current = window.requestAnimationFrame(() => {
        syncCarouselState();
      });
    };

    const raf = window.requestAnimationFrame(() => {
      mobileActiveSlideRef.current = 1;
      root.scrollTo({ left: root.clientWidth, behavior: 'auto' });
      syncCarouselState();
    });

    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', snapToActiveSlide);

    return () => {
      window.cancelAnimationFrame(raf);
      if (mobileScrollRafRef.current !== null) {
        window.cancelAnimationFrame(mobileScrollRafRef.current);
        mobileScrollRafRef.current = null;
      }
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', snapToActiveSlide);
    };
  }, [childParts.length, isMobileCarousel]);

  const shouldStartCarouselDrag = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return true;
    }

    return (
      target.closest(
        'button, a, input, textarea, select, label, [role="button"], [role="link"]',
      ) === null
    );
  };

  const startCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !isMobileCarousel ||
      event.pointerType !== 'mouse' ||
      event.button !== 0
    ) {
      return;
    }

    if (!shouldStartCarouselDrag(event.target)) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    event.preventDefault();

    mobileDragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: root.scrollLeft,
      dragging: false,
    };
    setIsCarouselDragging(true);

    try {
      root.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not guaranteed for all environments.
    }
  };

  const moveCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = mobileDragStateRef.current;
    const root = rootRef.current;
    if (!dragState || !root || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startX;
    if (!dragState.dragging && Math.abs(deltaX) < 4) {
      return;
    }

    dragState.dragging = true;
    root.scrollLeft = dragState.startScrollLeft - deltaX;
  };

  const endCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = mobileDragStateRef.current;
    const root = rootRef.current;
    if (!dragState || !root || dragState.pointerId !== event.pointerId) {
      return;
    }

    mobileDragStateRef.current = null;

    try {
      root.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release failures in older/partial pointer implementations.
    }

    if (dragState.dragging) {
      const slideWidth = root.clientWidth || 1;
      mobileActiveSlideRef.current = clamp(
        Math.round(root.scrollLeft / slideWidth),
        0,
        2,
      );
      root.scrollTo({
        left: mobileActiveSlideRef.current * slideWidth,
        behavior: 'smooth',
      });
    }

    setIsCarouselDragging(false);
  };

  const startHorizontalResize = (
    side: 'left' | 'right',
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (window.innerWidth < 768) return;
    const root = rootRef.current;
    if (!root) return;
    const startRect = root.getBoundingClientRect();
    const startSplit = getEffectiveSplit(
      leftWidthPct,
      rightWidthPct,
      startRect.width,
    );
    if (startSplit.availableWidth <= 0) return;
    const boundary =
      side === 'left'
        ? startRect.left + (startSplit.availableWidth * startSplit.left) / 100
        : startRect.right -
          (startSplit.availableWidth * startSplit.right) / 100;
    const grabOffset = event.clientX - boundary;
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const root = rootRef.current;
      if (!root || window.innerWidth < 768) return;
      const rect = root.getBoundingClientRect();
      const split = getEffectiveSplit(leftWidthPct, rightWidthPct, rect.width);
      if (split.availableWidth <= 0) return;
      setRootWidth(rect.width);
      const pointerBoundary = moveEvent.clientX - grabOffset;

      if (side === 'left') {
        const nextLeft =
          ((pointerBoundary - rect.left) / split.availableWidth) * 100;
        const maximumLeft = Math.min(34, Math.max(0, 68 - split.right));
        setLeftWidthPct(
          clamp(nextLeft, Math.min(14, maximumLeft), maximumLeft),
        );
      } else {
        const nextRight =
          ((rect.right - pointerBoundary) / split.availableWidth) * 100;
        setRightWidthPct(
          getEffectiveSplit(leftWidthPct, nextRight, rect.width).right,
        );
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const effectiveSplit = getEffectiveSplit(
    leftWidthPct,
    rightWidthPct,
    rootWidth,
  );
  const centerWidthPct = effectiveSplit.center;
  const goToSlide = (slide: number) => {
    const root = rootRef.current;
    if (!root || !isMobileCarousel) {
      return;
    }

    const nextSlide = clamp(slide, 0, 2);
    mobileActiveSlideRef.current = nextSlide;
    root.scrollTo({
      left: nextSlide * root.clientWidth,
      behavior: 'smooth',
    });
  };

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

      if (!isDesktop && flexDirection !== 'row') {
        console.warn(
          '[LayoutHydration] Mobile viewport but layout is not row',
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
    '--left-panel-width':
      !isMobileCarousel && rootWidth > HORIZONTAL_SEPARATOR_SPACE
        ? `${(effectiveSplit.availableWidth * effectiveSplit.left) / 100}px`
        : `${leftWidthPct}%`,
    '--center-panel-width':
      !isMobileCarousel && rootWidth > HORIZONTAL_SEPARATOR_SPACE
        ? `${(effectiveSplit.availableWidth * centerWidthPct) / 100}px`
        : `${100 - leftWidthPct - rightWidthPct}%`,
    '--right-panel-width':
      !isMobileCarousel && rootWidth > HORIZONTAL_SEPARATOR_SPACE
        ? `${Math.max(RIGHT_PANEL_MIN_WIDTH, (effectiveSplit.availableWidth * effectiveSplit.right) / 100)}px`
        : `${rightWidthPct}%`,
  } as CSSProperties;

  return (
    <HomeMobileCarouselContext.Provider
      value={{
        isMobileCarousel,
        activeSlide: mobileActiveSlide,
        hasPrev: isMobileCarousel && hasMobilePrev,
        hasNext: isMobileCarousel && hasMobileNext,
        goToSlide,
      }}
    >
      <div
        ref={rootRef}
        className="app-layout-row"
        style={layoutVars}
        data-carousel-mode={isMobileCarousel ? 'mobile' : 'desktop'}
        data-carousel-active-slide={mobileActiveSlide}
        data-carousel-dragging={isCarouselDragging ? 'true' : 'false'}
        data-carousel-has-prev={
          isMobileCarousel && hasMobilePrev ? 'true' : 'false'
        }
        data-carousel-has-next={
          isMobileCarousel && hasMobileNext ? 'true' : 'false'
        }
        aria-roledescription={isMobileCarousel ? 'carousel' : undefined}
        aria-label={isMobileCarousel ? 'Chat panels' : undefined}
        aria-describedby={isMobileCarousel ? carouselHintId : undefined}
        onPointerDown={startCarouselDrag}
        onPointerMove={moveCarouselDrag}
        onPointerUp={endCarouselDrag}
        onPointerCancel={endCarouselDrag}
      >
        {isMobileCarousel && (
          <span
            id={carouselHintId}
            style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            Swipe left or right to move between the rooms panel, messages panel,
            and user information panel.
          </span>
        )}
        <div
          className="app-layout-pane app-layout-pane-left"
          data-carousel-pane="left"
        >
          {childParts[0]}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(event) => startHorizontalResize('left', event)}
          className="app-layout-separator app-layout-separator-vertical"
        />
        <div
          className="app-layout-pane app-layout-pane-center"
          data-carousel-pane="center"
        >
          {childParts[1]}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(event) => startHorizontalResize('right', event)}
          className="app-layout-separator app-layout-separator-vertical"
        />
        <div
          className="app-layout-pane app-layout-pane-right"
          data-carousel-pane="right"
        >
          {childParts[2]}
        </div>
      </div>
    </HomeMobileCarouselContext.Provider>
  );
};

export const SidePanel = ({
  children,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) => {
  return (
    <aside {...props} className={cn('app-side-panel', props.className)}>
      {children}
    </aside>
  );
};

export const MainPanel = ({
  children,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) => {
  return (
    <section {...props} className={cn('app-main-panel', props.className)}>
      {children}
    </section>
  );
};

export const Row = ({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) => {
  return (
    <div {...props} className={cn('app-row', className)}>
      {children}
    </div>
  );
};

type VerticalResizableSectionsProps = {
  storageKey: string;
  top: ReactNode;
  bottom: ReactNode;
  defaultTopSize?: number;
};

export const VerticalResizableSections = ({
  storageKey,
  top,
  bottom,
  defaultTopSize = 78,
}: VerticalResizableSectionsProps) => {
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
};

export const AppTextInput = (props: InputHTMLAttributes<HTMLInputElement>) => {
  return <input {...props} className={cn('app-text-input', props.className)} />;
};

export const BlockTextInput = (
  props: InputHTMLAttributes<HTMLInputElement>,
) => {
  return <AppTextInput {...props} className={cn('block', props.className)} />;
};

export const AppTextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AppTextArea(props, ref) {
  return (
    <textarea
      ref={ref}
      {...props}
      className={cn('app-text-input', props.className)}
    />
  );
});

export const PrimaryButton = (
  props: ButtonHTMLAttributes<HTMLButtonElement>,
) => {
  return (
    <button {...props} className={cn('app-primary-button', props.className)} />
  );
};
