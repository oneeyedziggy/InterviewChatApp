'use client';

import { useEffect } from 'react';
import { withBasePath } from '@/utils/appPaths';
import { AuthCard, PageShell } from '../components/layout/PageShell';
import { clearSession } from '../utils/gpg';

export default function Logout() {
  useEffect(() => {
    clearSession();
    window.location.replace(withBasePath('/login/'));
  }, []);

  return (
    <PageShell className="app-auth-shell">
      <AuthCard className="app-auth-card-content">
        <h1 className="app-auth-title">Signing You Out</h1>
        <p className="app-auth-helper">
          Clearing session and redirecting to login...
        </p>
      </AuthCard>
    </PageShell>
  );
}
