import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppLayoutRow } from './LayoutPrimitives';

const LEFT_KEY = 'home.layout.leftWidthPct';
const RIGHT_KEY = 'home.layout.rightWidthPct';

describe('AppLayoutRow measured desktop split', () => {
  let rootWidth: number;
  let rootLeft: number;
  let mobile: boolean;
  let notifyResize: () => void;
  let notifyMediaChange: () => void;
  let observe: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    rootWidth = 1008;
    rootLeft = 100;
    mobile = false;
    window.localStorage.clear();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    });
    observe = vi.fn();
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        get matches() {
          return query.includes('max-width') ? mobile : !mobile;
        },
        media: query,
        onchange: null,
        addEventListener: vi.fn((_event, callback) => {
          notifyMediaChange = () => (callback as () => void)();
        }),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function () {
        return {
          x: rootLeft,
          y: 0,
          left: rootLeft,
          right: rootLeft + rootWidth,
          top: 0,
          bottom: 800,
          width: rootWidth,
          height: 800,
          toJSON: () => ({}),
        };
      },
    );
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  const renderLayout = () => {
    const result = render(
      <AppLayoutRow>
        <div>Rooms</div>
        <div>Messages</div>
        <div>People</div>
      </AppLayoutRow>,
    );
    const root =
      result.container.querySelector<HTMLDivElement>('.app-layout-row')!;
    const width = (pane: 'left' | 'center' | 'right') =>
      Number.parseFloat(root.style.getPropertyValue(`--${pane}-panel-width`));
    return { ...result, root, width };
  };

  it('raises a hydrated 14% right preference to 200px without overwriting it', () => {
    localStorage.setItem(RIGHT_KEY, '14');
    const { root, width } = renderLayout();

    expect(observe).toHaveBeenCalledWith(root);
    expect(width('right')).toBeCloseTo(200);
    expect(width('left') + width('center') + width('right') + 8).toBeCloseTo(
      rootWidth,
    );
    expect(localStorage.getItem(RIGHT_KEY)).toBe('14');

    rootWidth = 2008;
    act(() => notifyResize());

    expect(width('right')).toBeCloseTo(280);
    expect(localStorage.getItem(RIGHT_KEY)).toBe('14');
  });

  it('allows the right minimum above 34% and yields left space to preserve 32% center', () => {
    rootWidth = 508;
    localStorage.setItem(LEFT_KEY, '34');
    localStorage.setItem(RIGHT_KEY, '14');
    const { width } = renderLayout();

    expect(width('right')).toBeCloseTo(200);
    expect(width('left')).toBeCloseTo(140);
    expect(width('center')).toBeCloseTo(160);
    expect(localStorage.getItem(LEFT_KEY)).toBe('34');
    expect(localStorage.getItem(RIGHT_KEY)).toBe('14');

    rootWidth = 1008;
    fireEvent(window, new Event('resize'));

    expect(width('left')).toBeCloseTo(340);
    expect(width('right')).toBeCloseTo(200);
    expect(width('center')).toBeCloseTo(460);
  });

  it('keeps the right minimum when a very narrow desktop cannot retain 32% center', () => {
    rootWidth = 258;
    const { width } = renderLayout();

    expect(width('right')).toBeCloseTo(200);
    expect(width('left')).toBe(0);
    expect(width('center')).toBeCloseTo(50);
    expect(width('left') + width('center') + width('right') + 8).toBeCloseTo(
      rootWidth,
    );

    rootWidth = 188;
    act(() => notifyResize());

    expect(width('right')).toBeCloseTo(200);
    expect(width('left')).toBe(0);
    expect(width('center')).toBe(0);
  });

  it('clamps a right drag at 200px and includes separator space in its preference', () => {
    const { width } = renderLayout();
    const rightSeparator = screen.getAllByRole('separator')[1];
    fireEvent.mouseDown(rightSeparator, { clientX: 870 });
    fireEvent.mouseMove(window, { clientX: 1090 });
    fireEvent.mouseUp(window);

    expect(width('right')).toBeCloseTo(200);
    expect(localStorage.getItem(RIGHT_KEY)).toBe('20');
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(width('right')).toBeCloseTo(200);
  });

  it('uses fresh root geometry during drag and preserves the separator grab offset', () => {
    const { width } = renderLayout();
    fireEvent.mouseDown(screen.getAllByRole('separator')[1], { clientX: 870 });
    fireEvent.mouseMove(window, { clientX: 870 });
    expect(width('right')).toBeCloseTo(240);
    expect(localStorage.getItem(RIGHT_KEY)).toBe('24');

    rootWidth = 1208;
    rootLeft = 150;
    fireEvent.mouseMove(window, { clientX: 1060 });
    fireEvent.mouseUp(window);

    expect(width('right')).toBeCloseTo(300);
    expect(localStorage.getItem(RIGHT_KEY)).toBe('25');
    expect(width('left') + width('center') + width('right') + 8).toBeCloseTo(
      rootWidth,
    );
  });

  it('limits left dragging using the rendered right minimum, not its saved 14%', () => {
    rootWidth = 508;
    localStorage.setItem(RIGHT_KEY, '14');
    const { width } = renderLayout();
    fireEvent.mouseDown(screen.getAllByRole('separator')[0], { clientX: 212 });
    fireEvent.mouseMove(window, { clientX: 500 });
    fireEvent.mouseUp(window);

    expect(width('left')).toBeCloseTo(140);
    expect(width('center')).toBeCloseTo(160);
    expect(width('right')).toBeCloseTo(200);
    expect(localStorage.getItem(RIGHT_KEY)).toBe('14');
  });

  it('retains the usual 34% right maximum when the pixel minimum does not require more', () => {
    const { width } = renderLayout();
    fireEvent.mouseDown(screen.getAllByRole('separator')[1], { clientX: 870 });
    fireEvent.mouseMove(window, { clientX: 200 });
    fireEvent.mouseUp(window);

    expect(width('right')).toBeCloseTo(340);
    expect(width('center')).toBeCloseTo(440);
    expect(localStorage.getItem(RIGHT_KEY)).toBe('34');
  });

  it('leaves mobile carousel width variables and preferences unchanged across resize', () => {
    mobile = true;
    rootWidth = 375;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 375,
    });
    localStorage.setItem(RIGHT_KEY, '14');
    const { root } = renderLayout();

    expect(root.getAttribute('data-carousel-mode')).toBe('mobile');
    expect(root.style.getPropertyValue('--left-panel-width')).toBe('22%');
    expect(root.style.getPropertyValue('--center-panel-width')).toBe('64%');
    expect(root.style.getPropertyValue('--right-panel-width')).toBe('14%');
    fireEvent.mouseDown(screen.getAllByRole('separator')[1], { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 200 });
    fireEvent.mouseUp(window);
    rootWidth = 640;
    act(() => notifyResize());

    expect(root.style.getPropertyValue('--right-panel-width')).toBe('14%');
    expect(localStorage.getItem(RIGHT_KEY)).toBe('14');

    mobile = false;
    rootWidth = 1008;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    });
    act(() => notifyMediaChange());
    act(() => notifyResize());

    expect(root.getAttribute('data-carousel-mode')).toBe('desktop');
    expect(root.style.getPropertyValue('--right-panel-width')).toBe('200px');
    expect(localStorage.getItem(RIGHT_KEY)).toBe('14');
  });

  it('disconnects the root observer on unmount', () => {
    const { unmount } = renderLayout();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
