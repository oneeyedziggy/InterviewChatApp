import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mdStringToReact } from './markdown';

describe('markdown rendering safety', () => {
  it('does not emit an executable href for dangerous URL schemes', () => {
    const { container } = render(
      <div>{mdStringToReact('[run](javascript:alert(1))')}</div>,
    );

    const hrefs = Array.from(container.querySelectorAll('a')).map((link) =>
      link.getAttribute('href'),
    );
    expect(
      hrefs.some((href) => /^(javascript|vbscript|data):/i.test(href || '')),
    ).toBe(false);
  });

  it('does not emit an executable src for dangerous image URLs', () => {
    const { container } = render(
      <div>
        {mdStringToReact('![pixel](data:text/html,<script>alert(1)</script>)')}
      </div>,
    );

    const srcs = Array.from(container.querySelectorAll('img')).map((image) =>
      image.getAttribute('src'),
    );
    expect(
      srcs.some((src) => /^(javascript|vbscript|data):/i.test(src || '')),
    ).toBe(false);
  });

  it('renders HTML-like input as text rather than markup', () => {
    const { container } = render(
      <div>{mdStringToReact('<script>alert(1)</script>')}</div>,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
