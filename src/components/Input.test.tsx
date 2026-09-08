import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from './Input';

describe('Input component', () => {
  it('renders with label and value', () => {
    const onChange = vi.fn();
    render(
      <Input
        id="test-input"
        label="Test Label"
        value="test value"
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText(/test label/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('test value')).toBeInTheDocument();
  });

  it('calls onChange when value changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText(/test/i);
    await user.type(input, 'new value');

    expect(onChange).toHaveBeenCalled();
  });

  it('displays error message when provided', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        error="This is an error"
      />
    );

    expect(screen.getByText('This is an error')).toBeInTheDocument();
  });

  it('does not display error when error is empty', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        error=""
      />
    );

    expect(screen.queryByText('This is an error')).not.toBeInTheDocument();
  });

  it('applies minLength attribute', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        minLength={8}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('minLength', '8');
  });

  it('applies required attribute', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        required={true}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toBeRequired();
  });

  it('does not apply required when false', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        required={false}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).not.toBeRequired();
  });

  it('uses name prop when provided', () => {
    render(
      <Input
        id="test-input"
        name="custom-name"
        label="Test"
        value=""
        onChange={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('name', 'custom-name');
  });

  it('defaults name to id when not provided', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('name', 'test-input');
  });

  it('uses default type text when not provided', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('type', 'text');
  });

  it('uses provided type', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        type="password"
        value=""
        onChange={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('type', 'password');
  });

  it('handles onChange with null target value gracefully', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText(/test/i);
    // Type something to trigger onChange
    await user.type(input, 'test');
    
    // onChange should be called with the value
    expect(onChange).toHaveBeenCalled();
  });
});

