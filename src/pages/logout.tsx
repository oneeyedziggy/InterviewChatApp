'use client';

import { useEffect } from 'react';
import { withBasePath } from '@/utils/appPaths';
import { clearSession } from '../utils/gpg';

export default function Logout() {
  useEffect(() => {
    clearSession();
    window.location.replace(withBasePath('/login'));
  }, []);

  return null;
}
