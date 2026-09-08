'use client';
import { AppLayoutRow } from '../components/home/LayoutPrimitives';
import { HomeCenterPanel } from '../components/home/HomeCenterPanel';
import { HomePageProvider } from '../contexts/home/HomePageContext';
import { HomeLeftPanel } from '../components/home/HomeLeftPanel';
import { HomeRightPanel } from '../components/home/HomeRightPanel';
import { useHomeAuth } from '../contexts/home/useHomePageSelectors';
import { PageShell } from '../components/layout/PageShell';
import { InPageDialogHost } from '../components/InPageDialogHost';
import { ServerTabsPanel } from '../components/ServerTabsPanel';

const HomeContent = () => {
  const { authToken, isSwitchingServer } = useHomeAuth();

  // The server rail always renders so the create-server control stays reachable,
  // including for accounts that have not joined any server yet.
  return (
    <PageShell>
      <InPageDialogHost />
      <div className="app-home-shell">
        {isSwitchingServer && (
          <div
            role="status"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 20,
              display: 'grid',
              placeItems: 'center',
              pointerEvents: 'none',
              color: 'var(--app-muted)',
              background: 'color-mix(in srgb, var(--app-bg) 72%, transparent)',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            Switching server...
          </div>
        )}
        <ServerTabsPanel />
        <AppLayoutRow>
          {authToken && <HomeLeftPanel />}
          {authToken && <HomeCenterPanel />}
          {authToken && <HomeRightPanel />}
        </AppLayoutRow>
      </div>
    </PageShell>
  );
};

const Home = () => {
  return (
    <HomePageProvider>
      <HomeContent />
    </HomePageProvider>
  );
};

export default Home;
