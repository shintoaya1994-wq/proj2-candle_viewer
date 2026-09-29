import { useEffect, useState } from 'react';

import { parseRoute } from './route';
import { MainWindow } from './windows/MainWindow';
import { StudyWindow } from './windows/StudyWindow';

/** The page is one of two windows, told apart by what follows the # in its address. */
export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const changed = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  return route.window === 'main' ? <MainWindow /> : <StudyWindow route={route} />;
}
