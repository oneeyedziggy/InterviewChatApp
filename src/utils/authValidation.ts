import { VALIDATION } from '../constants';
import { countUnicodeCodePoints } from './unicode';

export const getUsernameError = (username: string): string => {
  const usernameLength = countUnicodeCodePoints(username);
  if (!usernameLength) {
    return '';
  }
  if (usernameLength < VALIDATION.MIN_USERNAME_LENGTH) {
    return `Username must be at least ${VALIDATION.MIN_USERNAME_LENGTH} characters`;
  }
  if (/\s/.test(username)) {
    return 'Username cannot contain whitespace';
  }
  return '';
};

export type PasswordRequirementStatus = {
  hasMinLength: boolean;
  belowMaxLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasNumber: boolean;
  hasSpecial: boolean;
};

export const getPasswordRequirementStatus = (
  password: string,
): PasswordRequirementStatus => {
  const passwordLength = countUnicodeCodePoints(password);
  const hasMinLength = passwordLength >= VALIDATION.MIN_PASSWORD_LENGTH;
  const belowMaxLength =
    passwordLength < VALIDATION.MAX_PASSWORD_LENGTH_EXCLUSIVE;
  const hasUpper = /\p{Lu}/u.test(password);
  const hasLower = /\p{Ll}/u.test(password);
  const hasNumber = /\p{Nd}/u.test(password);
  const hasSpecial =
    /[^\p{L}\p{Nd}\s]/u.test(password) || /[_]/u.test(password);

  return {
    hasMinLength,
    belowMaxLength,
    hasUpper,
    hasLower,
    hasNumber,
    hasSpecial,
  };
};

export const getPasswordError = (password: string): string => {
  if (!countUnicodeCodePoints(password)) {
    return '';
  }

  const status = getPasswordRequirementStatus(password);
  if (!status.hasMinLength) {
    return `Password must be at least ${VALIDATION.MIN_PASSWORD_LENGTH} characters`;
  }
  if (!status.belowMaxLength) {
    return `Password must be shorter than ${VALIDATION.MAX_PASSWORD_LENGTH_EXCLUSIVE} characters`;
  }
  if (!status.hasUpper) {
    return 'Password must include at least one uppercase letter';
  }
  if (!status.hasLower) {
    return 'Password must include at least one lowercase letter';
  }
  if (!status.hasNumber) {
    return 'Password must include at least one number';
  }
  if (!status.hasSpecial) {
    return 'Password must include at least one special character';
  }

  return '';
};
