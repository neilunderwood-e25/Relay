import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('renderer design-system contract', () => {
  it('keeps the requested Shadcn preset configuration', () => {
    const config = JSON.parse(read('components.json')) as {
      style: string;
      iconLibrary: string;
      tailwind: { baseColor: string; cssVariables: boolean };
    };

    expect(config.style).toBe('base-nova');
    expect(config.iconLibrary).toBe('hugeicons');
    expect(config.tailwind).toMatchObject({ baseColor: 'zinc', cssVariables: true });
  });

  it('uses shared semantic colors instead of the removed teal accent', () => {
    const styles = read('src/renderer/src/styles.css');

    expect(styles).not.toMatch(/\b(?:teal|cyan|emerald)\b/i);
    expect(styles).toContain('--provider-claude:');
    expect(styles).toContain('--status-warning:');
  });

  it('keeps cards and buttons on the preset primitives', () => {
    const card = read('src/renderer/src/components/ui/Card.tsx');
    const button = read('src/renderer/src/components/ui/Button.tsx');

    expect(card).toContain('rounded-xl border border-border bg-card');
    expect(button).toContain('bg-primary text-primary-foreground');
    expect(button).toContain('disabled:opacity-50');
  });

  it('covers each renderer view with a labelled navigation target', () => {
    const sidebar = read('src/renderer/src/components/AppSidebar.tsx');

    expect(sidebar).toContain('aria-label={orchestratorName}');
    expect(sidebar).toContain('aria-label="Console"');
    expect(sidebar).toContain('aria-label="Worktrees"');
    expect(sidebar).toContain('aria-label="Activity"');
    expect(sidebar).toContain('aria-label="Settings"');
  });

  it('ships the operations views on shared UI primitives', () => {
    const activity = read('src/renderer/src/components/ActivityWorkspace.tsx');
    const settings = read('src/renderer/src/components/SettingsWorkspace.tsx');

    expect(activity).toContain("from './ui/dialog'");
    expect(activity).toContain('window.relay.listActivity');
    expect(settings).toContain("from './ui/Card'");
    expect(settings).toContain('window.relay.updatePreferences');
    expect(settings).toContain('window.relay.recoverOperations');
  });

  it('retains compact-window layout rules without crushing terminal controls', () => {
    const styles = read('src/renderer/src/styles.css');

    expect(styles).toContain('@media (max-height: 680px)');
    expect(styles).toContain('.terminal-card-header { min-height: 48px; padding-block: 6px; }');
    expect(styles).toContain('@media (max-width: 980px)');
  });
});
