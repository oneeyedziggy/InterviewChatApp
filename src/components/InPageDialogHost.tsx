'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DIALOG_EVENT_NAME,
  resolveInPageConfirm,
  type InPageDialogRequest,
  showInPageAlert,
} from '@/utils/inPageDialog';

type DialogState = InPageDialogRequest | null;

export function InPageDialogHost() {
  const [dialog, setDialog] = useState<DialogState>(null);

  useEffect(() => {
    const onDialog = (event: Event) => {
      const custom = event as CustomEvent<InPageDialogRequest>;
      if (!custom?.detail) return;
      setDialog(custom.detail);
    };

    const originalAlert = window.alert;
    window.alert = (message?: unknown) => {
      showInPageAlert(String(message ?? ''));
    };

    window.addEventListener(DIALOG_EVENT_NAME, onDialog as EventListener);

    return () => {
      window.removeEventListener(DIALOG_EVENT_NAME, onDialog as EventListener);
      window.alert = originalAlert;
    };
  }, []);

  const isConfirm = useMemo(() => dialog?.kind === 'confirm', [dialog]);

  const closeAlert = () => {
    setDialog(null);
  };

  const closeConfirm = (accepted: boolean) => {
    if (dialog?.id) {
      resolveInPageConfirm(dialog.id, accepted);
    }
    setDialog(null);
  };

  if (!dialog) return null;

  return (
    <div
      role="presentation"
      className="app-dialog-overlay"
      onClick={() => {
        if (isConfirm) {
          closeConfirm(false);
          return;
        }
        closeAlert();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        className="app-dialog-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-dialog-content">
          <h2 className="app-dialog-title">{dialog.title}</h2>
          <p className="app-dialog-message">{dialog.message}</p>
          <div className="app-dialog-actions">
            {isConfirm ? (
              <>
                <button
                  type="button"
                  className="app-primary-button"
                  onClick={() => closeConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="app-primary-button"
                  onClick={() => closeConfirm(true)}
                >
                  Confirm
                </button>
              </>
            ) : (
              <button
                type="button"
                className="app-primary-button"
                onClick={closeAlert}
              >
                OK
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
