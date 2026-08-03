import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CONTEXT_MENU_CLOSE_EVENT, closeOtherContextMenus } from './contextMenuEvents';

describe('contextMenuEvents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches a close event when window is available', () => {
    const dispatchEvent = vi.fn();
    Object.defineProperty(global, 'window', {
      value: { dispatchEvent },
      configurable: true,
    });

    closeOtherContextMenus();

    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(Event));
    const event = dispatchEvent.mock.calls[0][0] as Event;
    expect(event.type).toBe(CONTEXT_MENU_CLOSE_EVENT);
  });

  it('does nothing when window is unavailable', () => {
    Object.defineProperty(global, 'window', {
      value: undefined,
      configurable: true,
    });

    expect(() => closeOtherContextMenus()).not.toThrow();
  });
});
