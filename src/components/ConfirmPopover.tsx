import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { styled } from 'styled-components';
import { CONTEXT_MENU_CLOSE_EVENT } from '../utils/contextMenuEvents';

const Popover = styled.div`
  position: fixed;
  z-index: 13000;
  background: color-mix(in srgb, var(--app-surface) 96%, var(--app-panel));
  color: var(--app-fg);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(5, 18, 34, 0.24);
  padding: 10px;
  min-width: 200px;
  font-size: 13px;
`;

const PopoverActions = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 10px;
  justify-content: flex-end;
`;

const ActionButton = styled.button<{ $variant?: 'danger' | 'primary' }>`
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 700;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  cursor: pointer;
  background: ${(p) =>
    p.$variant === 'danger'
      ? 'color-mix(in srgb, #b32030 22%, var(--app-surface))'
      : p.$variant === 'primary'
        ? 'color-mix(in srgb, var(--brand-blue) 22%, var(--app-surface))'
        : 'color-mix(in srgb, var(--app-panel) 88%, var(--app-surface))'};
  border-color: ${(p) =>
    p.$variant === 'danger'
      ? 'color-mix(in srgb, #b32030 70%, var(--app-border))'
      : p.$variant === 'primary'
        ? 'color-mix(in srgb, var(--brand-blue) 70%, var(--app-border))'
        : 'var(--app-border)'};
  color: ${(p) =>
    p.$variant === 'danger'
      ? 'color-mix(in srgb, #b32030 82%, var(--app-fg))'
      : p.$variant === 'primary'
        ? 'color-mix(in srgb, var(--brand-blue) 82%, var(--app-fg))'
        : 'var(--app-fg)'};

  &:hover {
    background: ${(p) =>
      p.$variant === 'danger'
        ? 'color-mix(in srgb, #b32030 30%, var(--app-surface))'
        : p.$variant === 'primary'
          ? 'color-mix(in srgb, var(--brand-cyan) 28%, var(--app-surface))'
          : 'color-mix(in srgb, var(--brand-cyan) 16%, var(--app-surface))'};
    color: var(--app-fg);
  }
`;

type ConfirmPopoverProps = {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
  anchorRect: DOMRect | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmPopover({
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  anchorRect,
  onConfirm,
  onCancel,
}: ConfirmPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    const handleMenuClose = () => onCancel();
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handleMenuClose);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handleMenuClose);
    };
  }, [onCancel]);

  if (!anchorRect) return null;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <Popover
      ref={ref}
      style={{
        top: anchorRect.bottom + 4,
        left: Math.max(8, anchorRect.left - 120),
      }}
    >
      <div>{message}</div>
      <PopoverActions>
        <ActionButton type="button" onClick={onCancel}>
          {cancelLabel}
        </ActionButton>
        <ActionButton type="button" $variant={variant} onClick={onConfirm}>
          {confirmLabel}
        </ActionButton>
      </PopoverActions>
    </Popover>,
    document.body,
  );
}
