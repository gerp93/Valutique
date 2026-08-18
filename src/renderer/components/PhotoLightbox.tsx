import { useEffect } from 'react';
import { Photo } from '@shared/types/photo';
import PhotoImage from './PhotoImage';

/**
 * Full-screen view of one photo in a set, with keyboard and click navigation.
 * The inline hero on the item page is bounded to fit the layout; this is the
 * "actually let me look at this" view -- as large as the screen allows.
 */
export default function PhotoLightbox({
  photos,
  index,
  onIndexChange,
  onClose,
}: {
  photos: Photo[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') onIndexChange((index + 1) % photos.length);
      else if (event.key === 'ArrowLeft') onIndexChange((index - 1 + photos.length) % photos.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, photos.length, onIndexChange, onClose]);

  const photo = photos[index];
  if (!photo) return null;

  return (
    <div className="lightbox-scrim" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} title="Close (Esc)">
        ✕
      </button>

      {photos.length > 1 && (
        <button
          className="lightbox-nav lightbox-prev"
          onClick={(event) => {
            event.stopPropagation();
            onIndexChange((index - 1 + photos.length) % photos.length);
          }}
          title="Previous (←)"
        >
          ‹
        </button>
      )}

      <PhotoImage
        path={photo.relativePath}
        className="lightbox-image"
        // Clicking the photo itself shouldn't dismiss it -- only the backdrop.
        onClick={(event) => event.stopPropagation()}
      />

      {photos.length > 1 && (
        <button
          className="lightbox-nav lightbox-next"
          onClick={(event) => {
            event.stopPropagation();
            onIndexChange((index + 1) % photos.length);
          }}
          title="Next (→)"
        >
          ›
        </button>
      )}

      {photos.length > 1 && (
        <div className="lightbox-counter">
          {index + 1} / {photos.length}
        </div>
      )}
    </div>
  );
}
