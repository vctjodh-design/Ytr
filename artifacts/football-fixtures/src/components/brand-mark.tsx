import { Link } from 'wouter';
import { Goal } from 'lucide-react';

export function BrandMark() {
  return (
    <Link href="/" className="brand-mark" data-testid="link-home">
      <span className="brand-icon"><Goal size={20} strokeWidth={2.2} /></span>
      <span className="brand-name">TOUCHLINE<span> / DESK</span></span>
    </Link>
  );
}
