import { useEffect, useRef } from 'react';
import { styled } from 'styled-components';
import { CONTEXT_MENU_CLOSE_EVENT } from '../utils/contextMenuEvents';

const Popover = styled.div`
  position: absolute;
  z-index: 7000;
  background: #ffffff;
  border: 1px solid #9aa8b8;
  border-radius: 6px;
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
  padding: 4px 10px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: ${(p) =>
    p.$variant === 'danger'
      ? '#b02a37'
      : p.$variant === 'primary'
        ? '#165d9f'
        : '#edf2f7'};
  color: ${(p) =>
    p.$variant === 'danger' || p.$variant === 'primary' ? '#fff' : '#223042'};

  &:hover {
    background: ${(p) =>
      p.$variant === 'danger'
        ? '#7f1d28'
        : p.$variant === 'primary'
          ? '#103f6b'
          : '#dbe7f3'};
    color: #fff;
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

  return (
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
    </Popover>
  );
}
