import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cn } from './cn';
import { getUsernameError } from './authValidation';
import {
  closeOtherContextMenus,
  CONTEXT_MENU_CLOSE_EVENT,
} from './contextMenuEvents';
import {
  DIALOG_EVENT_NAME,
  resolveInPageConfirm,
  showInPageAlert,
  showInPageConfirm,
} from './inPageDialog';

describe('basic client utilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins class names and ignores falsey entries', () => {
    expect(cn('alpha', false, undefined, null, 'beta')).toBe('alpha beta');
  });

  it('validates usernames with the expected branches', () => {
    expect(getUsernameError('')).toBe('');
    expect(getUsernameError('short')).toContain('at least');
    expect(getUsernameError('valid name')).toBe(
      'Username cannot contain whitespace',
    );
    expect(getUsernameError('username')).toBe('');
  });

  it('dispatches the shared context menu close event', () => {
    const listener = vi.fn();
    window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, listener);

    closeOtherContextMenus();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, listener);
  });

  it('shows an in-page alert event with a default title', () => {
    const listener = vi.fn();
    window.addEventListener(DIALOG_EVENT_NAME, listener as EventListener);

    showInPageAlert('hello');

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail.kind).toBe('alert');
    expect(event.detail.title).toBe('Notice');
    expect(event.detail.message).toBe('hello');

    window.removeEventListener(DIALOG_EVENT_NAME, listener as EventListener);
  });

  it('shows and resolves an in-page confirm dialog', async () => {
    let requestId = '';
    const listener = (event: Event) => {
      const custom = event as CustomEvent;
      requestId = custom.detail.id;
    };
    window.addEventListener(DIALOG_EVENT_NAME, listener);

    const promise = showInPageConfirm('Proceed?', 'Confirm action');
    expect(requestId).not.toBe('');

    resolveInPageConfirm(requestId, true);
    await expect(promise).resolves.toBe(true);

    window.removeEventListener(DIALOG_EVENT_NAME, listener);
  });
});
