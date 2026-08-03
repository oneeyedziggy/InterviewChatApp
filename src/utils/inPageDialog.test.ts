import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { showInPageAlert, showInPageConfirm, resolveInPageConfirm } from './inPageDialog';

describe('inPageDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches an alert request when showing an alert', () => {
    const dispatchEvent = vi.fn();
    Object.defineProperty(global, 'window', {
      value: { dispatchEvent },
      configurable: true,
    });

    showInPageAlert('hello');

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as Event;
    expect(event.type).toBe('app-inpage-dialog-request');
  });

  it('resolves confirm requests', async () => {
    const dispatchEvent = vi.fn();
    Object.defineProperty(global, 'window', {
      value: { dispatchEvent },
      configurable: true,
    });

    const result = showInPageConfirm('Are you sure?');
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ id: string }>;
    resolveInPageConfirm(event.detail.id, true);

    await expect(result).resolves.toBe(true);
  });

  it('ignores confirm resolution when no resolver exists', () => {
    expect(() => resolveInPageConfirm('missing-id', true)).not.toThrow();
  });
});
