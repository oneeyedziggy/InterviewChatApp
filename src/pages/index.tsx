'use client';
import { AppLayoutRow } from '../components/home/LayoutPrimitives';
import { HomeCenterPanel } from '../components/home/HomeCenterPanel';
import { HomePageProvider } from '../contexts/home/HomePageContext';
import { HomeLeftPanel } from '../components/home/HomeLeftPanel';
import { HomeRightPanel } from '../components/home/HomeRightPanel';
import { useHomeAuth } from '../contexts/home/useHomePageSelectors';
import { PageShell } from '../components/layout/PageShell';

const HomeContent = () => {
  const { authToken } = useHomeAuth();

  if (!authToken) {
    return null;
  }

  return (
    <PageShell>
      <AppLayoutRow>
        <HomeLeftPanel />
        <HomeCenterPanel />
        <HomeRightPanel />
      </AppLayoutRow>
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
