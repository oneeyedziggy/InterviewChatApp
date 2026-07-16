import { VALIDATION } from '../constants';

export function getUsernameError(username: string): string {
  if (!username.length) {
    return '';
  }
  if (username.length < VALIDATION.MIN_USERNAME_LENGTH) {
    return `Username must be at least ${VALIDATION.MIN_USERNAME_LENGTH} characters`;
  }
  if (/\s/.test(username)) {
    return 'Username cannot contain whitespace';
  }
  return '';
}
