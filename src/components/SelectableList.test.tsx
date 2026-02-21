import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectableList } from './SelectableList';

describe('SelectableList component', () => {
  it('renders label and options', () => {
    const options = ['Option 1', 'Option 2', 'Option 3'];
    render(
      <SelectableList
        id="test-list"
        label="Test List"
        value="Option 1"
        options={options}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Test List:')).toBeInTheDocument();
    expect(screen.getByText('Option 1')).toBeInTheDocument();
    expect(screen.getByText('Option 2')).toBeInTheDocument();
    expect(screen.getByText('Option 3')).toBeInTheDocument();
  });

  it('highlights active option', () => {
    const { container } = render(
      <SelectableList
        id="test-list"
        label="Test"
        value="Option 2"
        options={['Option 1', 'Option 2', 'Option 3']}
        onSelect={vi.fn()}
      />
    );

    const activeOption = screen.getByText('Option 2');
    // Styled components apply styles via className
    expect(activeOption).toHaveAttribute('class');
    // The active option should have a different className than inactive ones
    const inactiveOption = screen.getByText('Option 1');
    expect(activeOption.className).not.toBe(inactiveOption.className);
  });

  it('does not highlight inactive options', () => {
    const { container } = render(
      <SelectableList
        id="test-list"
        label="Test"
        value="Option 1"
        options={['Option 1', 'Option 2']}
        onSelect={vi.fn()}
      />
    );

    const inactiveOption = screen.getByText('Option 2');
    expect(inactiveOption).toHaveAttribute('class');
    const computedStyle = window.getComputedStyle(inactiveOption);
    const fontWeight = computedStyle.fontWeight;
    const fontWeightNum = fontWeight === 'bold' ? 700 : (parseInt(fontWeight, 10) || 400);
    expect(fontWeightNum).toBeLessThan(700);
  });

  it('calls onSelect when option is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value="Option 1"
        options={['Option 1', 'Option 2']}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Option 2'));

    expect(onSelect).toHaveBeenCalledWith('Option 2');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('handles empty options array', () => {
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value=""
        options={[]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Test:')).toBeInTheDocument();
    expect(screen.queryByText('Option 1')).not.toBeInTheDocument();
  });

  it('handles value not in options', () => {
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value="NonExistent"
        options={['Option 1', 'Option 2']}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Option 1')).toBeInTheDocument();
    expect(screen.getByText('Option 2')).toBeInTheDocument();
    // No option should be highlighted
    const option1 = screen.getByText('Option 1');
    expect(option1).toHaveAttribute('class');
    const computedStyle = window.getComputedStyle(option1);
    const fontWeight = computedStyle.fontWeight;
    const fontWeightNum = fontWeight === 'bold' ? 700 : (parseInt(fontWeight, 10) || 400);
    expect(fontWeightNum).toBeLessThan(700);
  });

  it('renders with correct id attribute', () => {
    render(
      <SelectableList
        id="custom-id"
        label="Test"
        value=""
        options={[]}
        onSelect={vi.fn()}
      />
    );

    const wrapper = document.getElementById('custom-id');
    expect(wrapper).toBeInTheDocument();
  });

  it('calls onSelect for each option when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value=""
        options={['Option 1', 'Option 2', 'Option 3']}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Option 1'));
    await user.click(screen.getByText('Option 2'));
    await user.click(screen.getByText('Option 3'));

    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenNthCalledWith(1, 'Option 1');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'Option 2');
    expect(onSelect).toHaveBeenNthCalledWith(3, 'Option 3');
  });
});

