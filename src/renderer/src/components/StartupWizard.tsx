import { useState } from 'react';
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Database01Icon,
  Folder01Icon,
  FolderGitIcon
} from '@hugeicons/core-free-icons';
import type { AppSnapshot } from '../../../shared/contracts';
import { Button } from './ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';

interface StartupWizardProps {
  onComplete: (snapshot: AppSnapshot) => void;
}

export function StartupWizard({ onComplete }: StartupWizardProps): React.JSX.Element {
  const [step, setStep] = useState<'home' | 'project'>('home');
  const [harnessHome, setHarnessHome] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (purpose: 'home' | 'project'): Promise<void> => {
    setError(null);
    try {
      const selected = await window.foundry.chooseDirectory(purpose);
      if (!selected) return;
      if (purpose === 'home') setHarnessHome(selected);
      else setProjectPath(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const finish = async (): Promise<void> => {
    if (!harnessHome || !projectPath) return;
    setBusy(true);
    setError(null);
    try {
      onComplete(await window.foundry.configureWorkspace({ harnessHome, projectPath }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const isHome = step === 'home';
  const selectedPath = isHome ? harnessHome : projectPath;

  return (
    <main className="startup-shell">
      <div className="startup-progress" aria-label="Setup progress">
        <span className="active"><b>1</b> Home</span>
        <span className={isHome ? '' : 'active'}><b>2</b> Project</span>
      </div>

      <Card className="startup-card">
        <CardHeader className="startup-card-header">
          <span className="startup-icon">
            <Icon icon={isHome ? Database01Icon : FolderGitIcon} size={22} />
          </span>
          <div>
            <h1>{isHome ? 'Harness Home' : 'Choose Project'}</h1>
            <p>{isHome ? 'Hive, worktrees, and data live here.' : 'Select the Git repository to open.'}</p>
          </div>
        </CardHeader>

        <CardContent className="startup-card-content">
          <button className={`startup-folder ${selectedPath ? 'selected' : ''}`} onClick={() => void choose(isHome ? 'home' : 'project')}>
            <Icon icon={isHome ? Folder01Icon : FolderGitIcon} size={20} />
            <span>
              <strong>{selectedPath ? folderName(selectedPath) : 'Choose folder'}</strong>
              <small>{selectedPath || (isHome ? 'Outside your project' : 'Git repository')}</small>
            </span>
          </button>
          {error && <div className="startup-error" role="alert">{error}</div>}
        </CardContent>

        <CardFooter className="startup-card-footer">
          {!isHome && (
            <Button variant="ghost" onClick={() => { setError(null); setStep('home'); }}>
              <Icon icon={ArrowLeft01Icon} size={15} /> Back
            </Button>
          )}
          <Button
            className="startup-next"
            disabled={!selectedPath || busy}
            onClick={() => {
              if (isHome) {
                setError(null);
                setStep('project');
              } else {
                void finish();
              }
            }}
          >
            {busy ? 'Starting' : isHome ? 'Continue' : 'Open Foundry'}
            {!busy && <Icon icon={ArrowRight01Icon} size={15} />}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
