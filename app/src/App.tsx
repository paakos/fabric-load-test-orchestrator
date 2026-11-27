import { AppProvider, useApp } from './lib/store';
import { HelpPanel } from './views/HelpPanel';
import { EnvironmentView } from './views/EnvironmentView';
import { LaunchView } from './views/LaunchView';
import { ReportsView } from './views/ReportsView';
import { RunsView } from './views/RunsView';
import { Badge } from './components/ui';

const NAV = [
  { page: 'launch', href: '#/launch', label: 'Parameters & launch' },
  { page: 'runs', href: '#/runs', label: 'Runs' },
  { page: 'reports', href: '#/reports', label: 'Reports' },
  { page: 'environment', href: '#/environment', label: 'Environment' },
] as const;

function Shell() {
  const app = useApp();
  const { route } = app;
  return (
    <div className={`shell${route.help ? ' with-help' : ''}`}>
      <a className="skip" href="#main">Skip to the content</a>
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden="true">▤</span> Load Test {app.backend.demo && <Badge tone="warn">demo · synthetic data</Badge>}</div>
        <div className="top-status" aria-label="Connection">
          <span>{app.workspaceName ? `Workspace: ${app.workspaceName}` : 'No workspace'}</span>
          <span>{app.lakehouseName ? `Lakehouse: ${app.lakehouseName}` : ''}</span>
          <span>{app.account ? `Signed in: ${app.account.name}` : <button type="button" className="link on-dark" onClick={() => void app.signIn()}>Sign in</button>}</span>
        </div>
        <a className="btn ghost help-open" href="#/help" aria-label="Open the help panel">? Help</a>
      </header>
      <nav className="rail" aria-label="Pages">
        <ul>
          {NAV.map((n) => (
            <li key={n.page}>
              <a href={n.href} aria-current={route.page === n.page ? 'page' : undefined} className={route.page === n.page ? 'on' : ''}>
                {n.label}{n.page === 'runs' && app.activeRuns > 0 && <span className="count" aria-label={`${app.activeRuns} running`}>{app.activeRuns}</span>}
              </a>
            </li>
          ))}
        </ul>
        {app.warnedWorkspace && <p className="rail-warn">This workspace is flagged as not for tests.</p>}
      </nav>
      <main id="main" tabIndex={-1}>
        {route.page === 'launch' && <LaunchView />}
        {route.page === 'runs' && <RunsView />}
        {route.page === 'reports' && <ReportsView />}
        {route.page === 'environment' && <EnvironmentView />}
      </main>
      <HelpPanel />
    </div>
  );
}

export function App() {
  return <AppProvider><Shell /></AppProvider>;
}
