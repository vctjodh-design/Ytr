import { Shield } from 'lucide-react';

export function TeamCrest({ src, name, size = 'md' }: { src?: string | null; name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`team-crest crest-${size}`} data-testid={`team-crest-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      {src ? <img src={src} alt={`${name} crest`} loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <Shield size={size === 'lg' ? 30 : 20} strokeWidth={1.5} />}
    </span>
  );
}
