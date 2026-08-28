import { cn } from '../../lib/utils';

export function Separator({ className, orientation = 'horizontal' }: {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}): React.JSX.Element {
  return <div role="separator" aria-orientation={orientation} className={cn('ui-separator', `ui-separator-${orientation}`, className)} />;
}
