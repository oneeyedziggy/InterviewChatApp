import { styled } from 'styled-components';

export const ContextMenuSurface = styled.div<{
  $top: number;
  $left: number;
  $zIndex?: number;
  $minWidth?: number;
}>`
  position: fixed;
  left: ${(p) => `${p.$left}px`};
  top: ${(p) => `${p.$top}px`};
  z-index: ${(p) => p.$zIndex ?? 12000};
  min-width: ${(p) => `${p.$minWidth ?? 150}px`};
  padding: 6px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-surface) 96%, var(--app-panel));
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.24);
`;

export const ContextMenuItem = styled.button<{
  $danger?: boolean;
  $active?: boolean;
}>`
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  background: ${(p) =>
    p.$active
      ? 'color-mix(in srgb, var(--brand-blue) 26%, var(--app-surface))'
      : 'transparent'};
  color: ${(p) =>
    p.$danger
      ? 'color-mix(in srgb, #b32030 72%, var(--app-fg))'
      : 'var(--app-fg)'};
  cursor: pointer;
  font-size: 12px;
  font-weight: ${(p) => (p.$danger ? 700 : 600)};
  line-height: 1.2;

  &:hover {
    background: ${(p) =>
      p.$danger
        ? 'color-mix(in srgb, #b32030 22%, var(--app-surface))'
        : 'color-mix(in srgb, var(--brand-cyan) 22%, var(--app-surface))'};
    color: var(--app-fg);
  }

  &:not(:last-child) {
    margin-bottom: 2px;
  }
`;
