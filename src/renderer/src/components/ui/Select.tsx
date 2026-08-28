import * as SelectPrimitive from '@radix-ui/react-select';
import { ArrowDown01Icon, Tick01Icon } from '@hugeicons/core-free-icons';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/utils';
import { Icon } from './Icon';

export const Select = SelectPrimitive.Root;

export function SelectTrigger({ className, children, ...props }:
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>): React.JSX.Element {
  return (
    <SelectPrimitive.Trigger className={cn('ui-select-trigger', className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild><Icon icon={ArrowDown01Icon} size={13} /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export const SelectValue = SelectPrimitive.Value;

export function SelectContent({ className, children, ...props }:
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>): React.JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className={cn('ui-select-content', className)} position="popper" sideOffset={5} {...props}>
        <SelectPrimitive.Viewport className="ui-select-viewport">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }:
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>): React.JSX.Element {
  return (
    <SelectPrimitive.Item className={cn('ui-select-item', className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ui-select-indicator">
        <Icon icon={Tick01Icon} size={12} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
