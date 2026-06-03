import { useEffect, useRef } from 'react';
import { styled } from 'styled-components';

const Popover = styled.div`
  position: absolute;
  z-index: 1000;
  background: white;
  border: 1px solid #ccc;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
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
  background: ${(p) => (p.$variant === 'danger' ? '#e74c3c' : p.$variant === 'primary' ? '#3498db' : '#eee')};
  color: ${(p) => (p.$variant === 'danger' || p.$variant === 'primary' ? 'white' : '#333')};

  &:hover {
    opacity: 0.9;
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
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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
