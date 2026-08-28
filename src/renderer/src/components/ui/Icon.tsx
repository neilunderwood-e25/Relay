import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react';

export function Icon({ icon, size = 18, strokeWidth = 1.7, ...props }:
  Omit<HugeiconsIconProps, 'icon'> & { icon: IconSvgElement }): React.JSX.Element {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
}
