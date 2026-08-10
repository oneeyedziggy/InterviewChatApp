import React from 'react';

type PasswordVisibilityToggleProps = {
  showing: boolean;
  onToggle: () => void;
  disabled?: boolean;
};

export const PasswordVisibilityToggle = ({
  showing,
  onToggle,
  disabled = false,
}: PasswordVisibilityToggleProps) => {
  return (
    <button
      type="button"
      className="app-auth-password-toggle"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={showing}
      aria-label={showing ? 'Hide password' : 'Show password'}
      title={showing ? 'Hide password' : 'Show password'}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        className="app-auth-password-toggle-icon"
      >
        {showing ? (
          <>
            <path
              d="M3.5 12s2.8-6.5 8.5-6.5S20.5 12 20.5 12s-2.8 6.5-8.5 6.5S3.5 12 3.5 12Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M4 4l16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </>
        ) : (
          <>
            <path
              d="M3.5 12s2.8-6.5 8.5-6.5S20.5 12 20.5 12s-2.8 6.5-8.5 6.5S3.5 12 3.5 12Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
          </>
        )}
      </svg>
    </button>
  );
};

export default PasswordVisibilityToggle;