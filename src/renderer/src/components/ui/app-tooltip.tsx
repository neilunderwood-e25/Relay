import type { ReactElement, ReactNode } from 'react';
import {
  Tooltip as TooltipRoot,
  TooltipContent,
  TooltipTrigger
} from './Tooltip';

export function Tooltip({
  children,
  content,
  side = 'top'
}: {
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): React.JSX.Element {
  return (
    <TooltipRoot>
      <TooltipTrigger render={children as ReactElement} />
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  );
}
