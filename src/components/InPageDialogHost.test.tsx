import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react-dom/test-utils';
import { InPageDialogHost } from './InPageDialogHost';
import {
  DIALOG_EVENT_NAME,
  showInPageAlert,
  showInPageConfirm,
} from '../utils/inPageDialog';

describe('InPageDialogHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders alert dialogs and closes them', async () => {
    const user = userEvent.setup();
    render(<InPageDialogHost />);

    await act(async () => {
      showInPageAlert('Something happened', 'Alert title');
    });

    expect(
      screen.getByRole('dialog', { name: 'Alert title' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves confirm dialogs when the user accepts', async () => {
    const user = userEvent.setup();
    render(<InPageDialogHost />);

    let confirmPromise: Promise<boolean>;
    await act(async () => {
      confirmPromise = showInPageConfirm('Continue?', 'Please Confirm');
    });

    expect(
      screen.getByRole('dialog', { name: 'Please Confirm' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await expect(confirmPromise!).resolves.toBe(true);
  });

  it('restores window.alert with a custom in-page bridge', async () => {
    const originalAlert = window.alert;
    render(<InPageDialogHost />);

    expect(window.alert).not.toBe(originalAlert);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(DIALOG_EVENT_NAME, {
          detail: {
            id: '1',
            kind: 'alert',
            title: 'Notice',
            message: 'Bridge',
          },
        }),
      );
    });

    expect(screen.getByText('Bridge')).toBeInTheDocument();
  });
});
