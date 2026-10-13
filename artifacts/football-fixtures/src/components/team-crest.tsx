import { Shield } from 'lucide-react';
import { Link } from 'wouter';

export function TeamCrest({ src, name, size = 'md', teamSlug }: { src?: string | null; name: string; size?: 'sm' | 'md' | 'lg'; teamSlug?: string | null }) {
  const crest = (
    <span className={`team-crest crest-${size}`} data-testid={`team-crest-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      {src ? <img src={src} alt={`${name} crest`} loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <Shield size={size === 'lg' ? 30 : 20} strokeWidth={1.5} />}
    </span>
  );

  return teamSlug ? (
    <Link
      href={`/team/${encodeURIComponent(teamSlug)}`}
      className="team-crest-link"
      aria-label={`Open ${name} team profile`}
      title={`Open ${name} team profile`}
      data-testid={`link-team-${teamSlug}`}
    >
      {crest}
    </Link>
  ) : crest;
}
