'use client';

import { useEffect } from 'react';
import { clearSession } from '../utils/gpg';

export default function Logout() {
  useEffect(() => {
    clearSession();
    window.location.replace('/login');
  }, []);

  return null;
}
