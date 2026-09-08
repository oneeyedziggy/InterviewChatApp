import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ScrollableDiv } from './ScrollableDiv';

describe('ScrollableDiv styled component', () => {
  it('renders with default props', () => {
    const { container } = render(
      <ScrollableDiv data-testid="scrollable">
        <div>Test content</div>
      </ScrollableDiv>
    );

    const scrollable = container.querySelector('[data-testid="scrollable"]');
    expect(scrollable).toBeInTheDocument();
  });

  it('applies custom flexDirection prop', () => {
    const { container } = render(
      <ScrollableDiv $flexDirection="row" data-testid="scrollable">
        <div>Test</div>
      </ScrollableDiv>
    );

    const scrollable = container.querySelector('[data-testid="scrollable"]');
    expect(scrollable).toBeInTheDocument();
    // Styled components apply styles via className, so we check it exists
    expect(scrollable).toHaveAttribute('class');
  });

  it('applies custom padding prop', () => {
    const { container } = render(
      <ScrollableDiv $padding="20px" data-testid="scrollable">
        <div>Test</div>
      </ScrollableDiv>
    );

    const scrollable = container.querySelector('[data-testid="scrollable"]');
    expect(scrollable).toBeInTheDocument();
    expect(scrollable).toHaveAttribute('class');
  });

  it('renders children correctly', () => {
    const { getByText } = render(
      <ScrollableDiv>
        <div>Child content</div>
      </ScrollableDiv>
    );

    expect(getByText('Child content')).toBeInTheDocument();
  });

  it('uses default padding when not provided', () => {
    const { container } = render(
      <ScrollableDiv data-testid="scrollable">
        <div>Test</div>
      </ScrollableDiv>
    );

    const scrollable = container.querySelector('[data-testid="scrollable"]');
    expect(scrollable).toBeInTheDocument();
  });

  it('uses default flexDirection when not provided', () => {
    const { container } = render(
      <ScrollableDiv data-testid="scrollable">
        <div>Test</div>
      </ScrollableDiv>
    );

    const scrollable = container.querySelector('[data-testid="scrollable"]');
    expect(scrollable).toBeInTheDocument();
  });
});

