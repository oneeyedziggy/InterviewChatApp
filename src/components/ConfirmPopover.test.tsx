import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmPopover } from './ConfirmPopover';
import { CONTEXT_MENU_CLOSE_EVENT } from '../utils/contextMenuEvents';

describe('ConfirmPopover', () => {
  it('renders into a portal and dispatches callbacks', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const anchorRect = {
      bottom: 100,
      left: 40,
      right: 140,
    } as DOMRect;

    render(
      <ConfirmPopover
        message="Confirm this action?"
        confirmLabel="Yes"
        cancelLabel="No"
        variant="danger"
        anchorRect={anchorRect}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('Confirm this action?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on shared context menu close events', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmPopover
        message="Confirm this action?"
        anchorRect={{ bottom: 100, left: 40, right: 140 } as DOMRect}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    window.dispatchEvent(new Event(CONTEXT_MENU_CLOSE_EVENT));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
