import {
  Activity01Icon,
  DashboardSquare01Icon,
  FolderGitIcon,
  GitBranchIcon,
  Robot01Icon,
  Settings01Icon
} from '@hugeicons/core-free-icons';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { Separator } from './ui/Separator';
import { Tooltip } from './ui/Tooltip';

export type AppView = 'rehan' | 'console' | 'worktrees';

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
            className={`sidebar-nav-button ${activeView === 'rehan' ? 'active' : ''}`}
            aria-label={orchestratorName}
            onClick={() => onNavigate('rehan')}
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
          <span className="disabled-tooltip-target">
            <Button variant="ghost" size="icon" className="sidebar-nav-button" disabled aria-label="Activity">
              <Icon icon={Activity01Icon} />
            </Button>
          </span>
        </Tooltip>
      </nav>

      <div className="sidebar-footer">
        <Tooltip content="Settings" side="right">
          <span className="disabled-tooltip-target">
            <Button variant="ghost" size="icon" className="sidebar-nav-button" disabled aria-label="Settings">
              <Icon icon={Settings01Icon} />
            </Button>
          </span>
        </Tooltip>
      </div>
    </aside>
  );
}
