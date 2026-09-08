import { describe, expect, it } from 'vitest';
import {
  getPasswordError,
  getPasswordRequirementStatus,
  getUsernameError,
} from './authValidation';

describe('authValidation', () => {
  it('keeps username validation behavior', () => {
    expect(getUsernameError('')).toBe('');
    expect(getUsernameError('short')).toContain('at least');
    expect(getUsernameError('valid name')).toBe(
      'Username cannot contain whitespace',
    );
    expect(getUsernameError('validUser')).toBe('');
  });

  it('counts astral Unicode characters as one username character', () => {
    expect(getUsernameError('😀😀😀😀😀😀😀😀')).toBe('');
    expect(getUsernameError('😀😀😀😀😀😀😀')).toContain('at least');
  });

  it('reports password requirement status with UTF-8 support', () => {
    const status = getPasswordRequirementStatus('Äbcdefghi1!');
    expect(status).toEqual({
      hasMinLength: true,
      belowMaxLength: true,
      hasUpper: true,
      hasLower: true,
      hasNumber: true,
      hasSpecial: true,
    });
  });

  it('returns specific password errors by policy order', () => {
    expect(getPasswordError('')).toBe('');
    expect(getPasswordError('short1!A')).toContain('at least');
    expect(getPasswordError('A'.repeat(256))).toContain('shorter than');
    expect(getPasswordError('lowercase1!')).toContain('uppercase');
    expect(getPasswordError('UPPERCASE1!')).toContain('lowercase');
    expect(getPasswordError('NoDigits!!')).toContain('number');
    expect(getPasswordError('NoSpecial12')).toContain('special');
    expect(getPasswordError('StrongPass1!')).toBe('');
  });

  it('counts astral Unicode characters as one password character', () => {
    expect(getPasswordRequirementStatus('😀😀😀😀😀😀😀😀😀😀')).toMatchObject({
      hasMinLength: true,
      belowMaxLength: true,
    });
  });
});
