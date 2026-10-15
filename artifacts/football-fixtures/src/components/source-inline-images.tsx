import type { MatchContentImage } from '@workspace/api-client-react';
import { Link } from 'wouter';

type Props = {
  images?: MatchContentImage[];
  playerSlug?: string;
  coachSlug?: string;
  className?: string;
};

export function SourceInlineImages({
  images,
  playerSlug,
  coachSlug,
  className = 'source-inline-images',
}: Props) {
  if (!images?.length) return null;

  return (
    <span className={className}>
      {images.map((image, index) => {
        const imageClass = [
          'source-inline-image',
          /\/flags\//i.test(image.url) ? 'is-flag' : '',
          /\/(?:players|people)\//i.test(image.url) ? 'is-person' : '',
        ].filter(Boolean).join(' ');
        const element = (
          <img
            className={imageClass}
            src={image.url}
            alt={image.alt || ''}
            loading="lazy"
            key={`${image.url}-${index}`}
          />
        );

        return playerSlug ? (
          <Link
            className="source-inline-image-link"
            href={`/player/${encodeURIComponent(playerSlug)}`}
            key={`${image.url}-${index}`}
          >
            {element}
          </Link>
        ) : coachSlug ? (
          <a
            className="source-inline-image-link"
            href={`https://www.besoccer.com/coach/${encodeURIComponent(coachSlug)}`}
            target="_blank"
            rel="noreferrer"
            key={`${image.url}-${index}`}
          >
            {element}
          </a>
        ) : element;
      })}
    </span>
  );
}
