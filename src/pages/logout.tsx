'use client';

import { useEffect } from 'react';
import { withBasePath, withServerQuery } from '@/utils/appPaths';
import { AuthCard, PageShell } from '../components/layout/PageShell';
import { clearSession } from '../utils/gpg';

const Logout = () => {
  useEffect(() => {
    const serverId =
      new URLSearchParams(window.location.search).get('server')?.trim() || '';
    clearSession();
    window.location.replace(withServerQuery(withBasePath('/login/'), serverId));
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
};
export default Logout;
