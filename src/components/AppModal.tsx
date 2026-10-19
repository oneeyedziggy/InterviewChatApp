import type { ReactNode } from 'react';

type AppModalProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  showCloseButton?: boolean;
  closeDisabled?: boolean;
  className?: string;
};

export const AppModal = ({
  open,
  title,
  children,
  actions,
  onClose,
  showCloseButton = false,
  closeDisabled = false,
  className = '',
}: AppModalProps) => {
  if (!open) return null;

  return (
    <div
      className="app-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (!closeDisabled && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`app-dialog-card app-dialog-card--modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-modal-title"
      >
        <div className="app-dialog-content">
          <div className="app-dialog-header">
            <h2 id="app-modal-title" className="app-dialog-title">
              {title}
            </h2>
            {showCloseButton && (
              <button
                type="button"
                className="app-dialog-close"
                aria-label="Close dialog"
                title="Close dialog"
                disabled={closeDisabled}
                onClick={onClose}
              >
                <span aria-hidden="true">X</span>
              </button>
            )}
          </div>
          {children}
          {actions && <div className="app-dialog-actions">{actions}</div>}
        </div>
      </section>
    </div>
  );
};
