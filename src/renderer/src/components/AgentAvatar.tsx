import { Avatar, Style } from '@dicebear/core';
import thumbs from '@dicebear/styles/thumbs.json';
import { cn } from '../lib/utils';

const thumbsStyle = new Style(thumbs);
const avatarCache = new Map<string, string>();

export function AgentAvatar({ seed, name, className }: {
  seed: string;
  name: string;
  className?: string;
}): React.JSX.Element {
  return (
    <img
      className={cn('agent-avatar', className)}
      src={avatarSource(seed)}
      alt={`${name} avatar`}
      draggable={false}
    />
  );
}

function avatarSource(seed: string): string {
  const cached = avatarCache.get(seed);
  if (cached) return cached;
  const source = new Avatar(thumbsStyle, {
    seed,
    animationVariant: 'slow'
  }).toDataUri();
  avatarCache.set(seed, source);
  return source;
}
