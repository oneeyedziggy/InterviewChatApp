import type { ReactNode } from 'react';

type AppModalProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
};

export const AppModal = ({
  open,
  title,
  children,
  actions,
  onClose,
}: AppModalProps) => {
  if (!open) return null;

  return (
    <div
      className="app-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="app-dialog-card app-dialog-card--modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-modal-title"
      >
        <div className="app-dialog-content">
          <h2 id="app-modal-title" className="app-dialog-title">
            {title}
          </h2>
          {children}
          {actions && <div className="app-dialog-actions">{actions}</div>}
        </div>
      </section>
    </div>
  );
};
