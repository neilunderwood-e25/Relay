import {
  Activity01Icon,
  DashboardSquare01Icon,
  FolderGitIcon,
  GitBranchIcon,
  Layers01Icon,
  Robot01Icon,
  Settings01Icon
} from '@hugeicons/core-free-icons';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { Separator } from './ui/Separator';
import { Tooltip } from './ui/app-tooltip';

export type AppView = 'orchestrator' | 'console' | 'worktrees' | 'library' | 'activity' | 'settings';

export function AppSidebar({ activeView, orchestratorName, onNavigate, onChooseDirectory }: {
  activeView: AppView;
  orchestratorName: string;
  onNavigate: (view: AppView) => void;
  onChooseDirectory: () => void;
}): React.JSX.Element {
  return (
    <aside className="app-sidebar" aria-label="Relay navigation">
      <Tooltip content="Choose project" side="right">
        <Button variant="ghost" size="icon" className="sidebar-project-button" onClick={onChooseDirectory} aria-label="Choose project">
          <Icon icon={FolderGitIcon} />
        </Button>
      </Tooltip>

      <Separator />

      <nav className="sidebar-navigation">
        <Tooltip content="Orchestrator" side="right">
          <Button
            variant="ghost"
            size="icon"
            className={`sidebar-nav-button ${activeView === 'orchestrator' ? 'active' : ''}`}
            aria-label={orchestratorName}
            onClick={() => onNavigate('orchestrator')}
          >
            <Icon icon={Robot01Icon} />
          </Button>
        </Tooltip>
        <Tooltip content="Console" side="right">
          <Button
            variant="ghost"
            size="icon"
            className={`sidebar-nav-button ${activeView === 'console' ? 'active' : ''}`}
            aria-label="Console"
            onClick={() => onNavigate('console')}
          >
            <Icon icon={DashboardSquare01Icon} />
          </Button>
        </Tooltip>
        <Tooltip content="Worktrees" side="right">
          <Button
            variant="ghost"
            size="icon"
            className={`sidebar-nav-button ${activeView === 'worktrees' ? 'active' : ''}`}
            aria-label="Worktrees"
            onClick={() => onNavigate('worktrees')}
          >
            <Icon icon={GitBranchIcon} />
          </Button>
        </Tooltip>
        <Tooltip content="Activity" side="right">
          <Button
            variant="ghost"
            size="icon"
            className={`sidebar-nav-button ${activeView === 'activity' ? 'active' : ''}`}
            aria-label="Activity"
            onClick={() => onNavigate('activity')}
          >
            <Icon icon={Activity01Icon} />
          </Button>
        </Tooltip>
        <Tooltip content="Agent library" side="right">
          <Button
            variant="ghost"
            size="icon"
            className={`sidebar-nav-button ${activeView === 'library' ? 'active' : ''}`}
            aria-label="Agent library"
            onClick={() => onNavigate('library')}
          >
            <Icon icon={Layers01Icon} />
          </Button>
        </Tooltip>
      </nav>

      <div className="sidebar-footer">
        <Tooltip content="Settings" side="right">
          <Button
            variant="ghost"
            size="icon"
            className={`sidebar-nav-button ${activeView === 'settings' ? 'active' : ''}`}
            aria-label="Settings"
            onClick={() => onNavigate('settings')}
          >
            <Icon icon={Settings01Icon} />
          </Button>
        </Tooltip>
      </div>
    </aside>
  );
}
