import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginDialog } from './LoginDialog';

// Mock fetch globally
global.fetch = vi.fn();

describe('LoginDialog component', () => {
  const mockSetUsername = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open is true', () => {
    render(
      <LoginDialog
        username=""
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
  });

  it('does not render when open is false', () => {
    const { container } = render(
      <LoginDialog
        username=""
        setUsername={mockSetUsername}
        open={false}
        onSuccess={mockOnSuccess}
      />
    );

    // The dialog element exists but is not open/visible
    const dialog = container.querySelector('dialog');
    expect(dialog).toBeInTheDocument();
    // When open=false, the dialog should not be shown (but still in DOM)
    // Check that login button is not accessible
    expect(screen.queryByRole('button', { name: /login/i })).not.toBeInTheDocument();
  });

  it('displays username error when username is too short', async () => {
    render(
      <LoginDialog
        username="short"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/username must be at least/i)).toBeInTheDocument();
    });
  });

  it('displays password error when password is too short', async () => {
    render(
      <LoginDialog
        username="validusername"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'short');

    await waitFor(() => {
      expect(screen.getByText(/password must be at least/i)).toBeInTheDocument();
    });
  });

  it('disables submit button when validation fails', async () => {
    render(
      <LoginDialog
        username="short"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const submitButton = screen.getByRole('button', { name: /login/i });
    expect(submitButton).toBeDisabled();
  });

  it('enables submit button when validation passes', async () => {
    render(
      <LoginDialog
        username="validusername"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'validpassword123');

    await waitFor(() => {
      const submitButton = screen.getByRole('button', { name: /login/i });
      expect(submitButton).not.toBeDisabled();
    });
  });

  it('calls onSuccess with sessionId on successful login', async () => {
    const mockResponse = { sessionId: 'test-session-id' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    render(
      <LoginDialog
        username="validusername"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'validpassword123');
    const submitButton = screen.getByRole('button', { name: /login/i });

    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalledWith('test-session-id');
    });
  });

  it('displays error message on failed login', async () => {
    const mockResponse = { error: 'Invalid credentials' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    render(
      <LoginDialog
        username="validusername"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'validpassword123');
    const submitButton = screen.getByRole('button', { name: /login/i });

    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });

    expect(mockOnSuccess).not.toHaveBeenCalled();
  });

  it('displays fallback error on network failure', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    render(
      <LoginDialog
        username="validusername"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'validpassword123');
    const submitButton = screen.getByRole('button', { name: /login/i });

    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });

  it('displays fallback error when response has no error or sessionId', async () => {
    const mockResponse = {};
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    render(
      <LoginDialog
        username="validusername"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'validpassword123');
    const submitButton = screen.getByRole('button', { name: /login/i });

    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });

  it('calls setUsername when username input changes', async () => {
    render(
      <LoginDialog
        username=""
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const usernameInput = screen.getByLabelText(/username/i);
    await userEvent.type(usernameInput, 'newuser');

    expect(mockSetUsername).toHaveBeenCalled();
  });

  it('sends correct request body to login endpoint', async () => {
    const mockResponse = { sessionId: 'test-session' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    render(
      <LoginDialog
        username="testuser"
        setUsername={mockSetUsername}
        open={true}
        onSuccess={mockOnSuccess}
      />
    );

    const passwordInput = screen.getByLabelText(/password/i);
    await userEvent.type(passwordInput, 'testpass123');
    const submitButton = screen.getByRole('button', { name: /login/i });

    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'testpass123' }),
      });
    });
  });
});

