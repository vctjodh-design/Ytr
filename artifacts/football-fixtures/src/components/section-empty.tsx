import { CircleDashed } from 'lucide-react';

export function SectionEmpty({ title, detail = 'No information was returned for this section.' }: { title: string; detail?: string }) {
  return (
    <div className="section-empty" data-testid={`empty-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <span className="empty-icon"><CircleDashed size={21} /></span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
