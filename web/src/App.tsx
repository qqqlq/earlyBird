import { useState, useEffect } from 'react';
import { Home } from './routes/Home.js';
import { Alarm } from './routes/Alarm.js';

type Page = 'home' | 'alarm';

function getPage(): Page {
  return window.location.hash === '#alarm' ? 'alarm' : 'home';
}

export default function App() {
  const [page, setPage] = useState<Page>(getPage);

  useEffect(() => {
    const handler = () => setPage(getPage());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  if (page === 'alarm') {
    return (
      <Alarm
        onDismiss={() => {
          window.location.hash = '';
          setPage('home');
        }}
      />
    );
  }

  return <Home />;
}
