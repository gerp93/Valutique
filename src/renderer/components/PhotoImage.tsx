import { MouseEvent } from 'react';

/**
 * Renders a photo from the media library.
 *
 * The URL is built synchronously rather than fetched over IPC: a 300-item grid
 * would otherwise fire 300 round trips just to learn paths it could compute.
 * The custom protocol is served by the main process and scoped to the library,
 * so the renderer never gets filesystem access.
 *
 * Paths are content hashes, so the images are safe to cache forever.
 */
export function photoUrl(relativePath: string): string {
  return `valutique-photo://media/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export default function PhotoImage({
  path,
  className,
  alt = '',
  onClick,
}: {
  path: string | null;
  className?: string;
  alt?: string;
  onClick?: (event: MouseEvent<HTMLImageElement>) => void;
}) {
  if (!path) {
    return <div className={className ?? 'item-thumb-placeholder'}>no photo</div>;
  }

  return <img src={photoUrl(path)} className={className} alt={alt} loading="lazy" onClick={onClick} />;
}
