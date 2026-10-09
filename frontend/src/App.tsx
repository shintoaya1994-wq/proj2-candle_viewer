import { useEffect, useState } from 'react';

import { API, api } from './api';
import { parseRoute } from './route';
import { ChatWindow } from './windows/ChatWindow';
import { MainWindow } from './windows/MainWindow';
import { StudyWindow } from './windows/StudyWindow';

/** Whether the program that answers is the one this interface was built for. */
type Program = 'unknown' | 'fits' | 'older' | 'newer' | 'silent';

/** The page is one of two windows, told apart by what follows the # in its address. */
export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [program, setProgram] = useState<Program>('unknown');

  useEffect(() => {
    const changed = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  // After an update the program keeps running as it was until it is started again, while the page is already the new one.
  useEffect(() => {
    api
      .meta()
      .then((meta) => setProgram((meta.api ?? 1) === API ? 'fits' : (meta.api ?? 1) < API ? 'older' : 'newer'))
      .catch(() => setProgram('silent'));
  }, []);

  if (program === 'unknown') return <div className="notice">正在读取…</div>;
  if (program === 'older') {
    return (
      <div className="notice" data-testid="restart">
        <h1>程序需要重新启动</h1>
        <p>软件已经更新，但正在运行的还是更新之前的程序。请在运行它的终端里按 Ctrl+C 停止，再运行一次：</p>
        <pre>uv run candle-viewer</pre>
        <p>然后刷新本页。已保存的记录不受影响。</p>
      </div>
    );
  }
  if (program === 'newer') {
    return (
      <div className="notice" data-testid="rebuild">
        <h1>界面需要重新构建</h1>
        <p>程序比界面新。请在代码目录里运行下面的命令，然后刷新本页。</p>
        <pre>cd frontend && npm install && npm run build</pre>
      </div>
    );
  }
  if (program === 'silent') {
    return (
      <div className="notice" data-testid="silent">
        <h1>连接不上程序</h1>
        <p>请确认程序正在运行（uv run candle-viewer），然后刷新本页。</p>
      </div>
    );
  }
  if (route.window === 'chat') return <ChatWindow route={route} />;
  return route.window === 'main' ? <MainWindow /> : <StudyWindow route={route} />;
}
