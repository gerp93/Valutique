import { useMemo, useState } from 'react';
import { ImportAnalysis, ImportResult } from '@shared/types/import';

/**
 * The "dump 50 photos in" flow.
 *
 * The design principle here is that reviewing is optional. Photos are grouped
 * automatically, the review grid is pre-filled with that grouping, and the
 * primary button is always "start" -- a user who trusts it never has to touch
 * anything, and a user who doesn't can drag photos between groups first.
 */
export default function ImportDialog({
  collectionId,
  itemNoun,
  onClose,
  onDone,
}: {
  collectionId: string;
  itemNoun: string;
  onClose: () => void;
  onDone: (result: ImportResult) => void;
}) {
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [groups, setGroups] = useState<number[][]>([]);
  const [autoGroup, setAutoGroup] = useState(true);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [autoProcess, setAutoProcess] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'choose' | 'review'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [movingPhoto, setMovingPhoto] = useState<number | null>(null);

  const duplicateCount = useMemo(
    () => analysis?.photos.filter((photo) => photo.duplicateOfItemId).length ?? 0,
    [analysis]
  );

  const pick = async (mode: 'files' | 'folder') => {
    const paths = mode === 'files' ? await window.valutique.import.pickFiles() : await window.valutique.import.pickFolder();
    if (paths.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const result = await window.valutique.import.analyze(collectionId, paths, autoGroup);
      setAnalysis(result);
      setGroups(result.groups.map((group) => group.photoIndexes));
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!analysis) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.valutique.import.commit(analysis, {
        collectionId,
        groups: groups.filter((group) => group.length > 0),
        skipDuplicates,
        autoProcess,
      });
      onDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // --- grouping edits ---
  // Kept deliberately simple: split one out, merge into the one above, or move
  // a chosen photo into any group. Enough to fix any grouping mistake without
  // building a drag-and-drop surface.

  const splitPhoto = (groupIndex: number, photoIndex: number) => {
    const next = groups.map((group) => group.filter((index) => index !== photoIndex));
    next.splice(groupIndex + 1, 0, [photoIndex]);
    setGroups(next.filter((group) => group.length > 0));
  };

  const mergeUp = (groupIndex: number) => {
    if (groupIndex === 0) return;
    const next = [...groups];
    next[groupIndex - 1] = [...next[groupIndex - 1], ...next[groupIndex]];
    next.splice(groupIndex, 1);
    setGroups(next);
  };

  const movePhotoTo = (photoIndex: number, targetGroup: number) => {
    const next = groups.map((group) => group.filter((index) => index !== photoIndex));
    next[targetGroup] = [...next[targetGroup], photoIndex];
    setGroups(next.filter((group) => group.length > 0));
    setMovingPhoto(null);
  };

  const setEachPhotoSeparate = () => {
    if (!analysis) return;
    setGroups(analysis.photos.map((_, index) => [index]));
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        {phase === 'choose' ? (
          <>
            <h2>Add photos</h2>
            <p className="card-hint">
              Drop in as many as you like — several angles of the same {itemNoun} and one-shot photos of others, all
              mixed together. Valutique works out which photos belong to the same physical object so you don't have to
              sort them first.
            </p>

            <div className="field-inline">
              <input
                id="auto-group"
                type="checkbox"
                checked={autoGroup}
                onChange={(event) => setAutoGroup(event.target.checked)}
              />
              <label htmlFor="auto-group">Group photos of the same {itemNoun} automatically</label>
            </div>
            <p className="field-hint" style={{ marginTop: -4, marginBottom: 16 }}>
              {autoGroup
                ? 'Uses capture times and a single quick look at the photos. Costs about a cent for a large batch, or nothing on a subscription connector.'
                : `Every photo becomes its own ${itemNoun}. Faster, and right if you shot one photo per piece.`}
            </p>

            {error && <div className="banner banner-bad">{error}</div>}

            <div className="modal-actions">
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={() => void pick('folder')} disabled={busy}>
                Choose a folder
              </button>
              <button className="btn btn-primary" onClick={() => void pick('files')} disabled={busy}>
                {busy ? 'Reading photos…' : 'Choose photos'}
              </button>
            </div>
          </>
        ) : (
          analysis && (
            <>
              <h2>
                {groups.length} {groups.length === 1 ? itemNoun : `${itemNoun}s`} from {analysis.photos.length} photos
              </h2>
              <p className="card-hint">{analysis.groupingNote}</p>

              {duplicateCount > 0 && (
                <div className="banner banner-warn">
                  {duplicateCount} {duplicateCount === 1 ? 'photo is' : 'photos are'} already in this library.
                  <div className="field-inline" style={{ marginTop: 8, marginBottom: 0 }}>
                    <input
                      id="skip-dupes"
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(event) => setSkipDuplicates(event.target.checked)}
                    />
                    <label htmlFor="skip-dupes">Skip them</label>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button className="btn btn-small" onClick={setEachPhotoSeparate}>
                  Make every photo its own {itemNoun}
                </button>
                {movingPhoto !== null && (
                  <button className="btn btn-small" onClick={() => setMovingPhoto(null)}>
                    Cancel move
                  </button>
                )}
              </div>

              <div className="group-list">
                {groups.map((group, groupIndex) => (
                  <div key={groupIndex} className="group-row">
                    <div className="group-row-header">
                      <span className="group-row-title">
                        {analysis.groups[groupIndex]?.label || `${itemNoun} ${groupIndex + 1}`}
                        <span className="text-muted" style={{ fontWeight: 400 }}>
                          {' '}
                          · {group.length} photo{group.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      <div className="group-row-actions">
                        {movingPhoto !== null && (
                          <button className="btn btn-small btn-primary" onClick={() => movePhotoTo(movingPhoto, groupIndex)}>
                            Move here
                          </button>
                        )}
                        {groupIndex > 0 && movingPhoto === null && (
                          <button className="btn btn-small" onClick={() => mergeUp(groupIndex)}>
                            Merge up
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="photo-strip">
                      {group.map((photoIndex) => {
                        const photo = analysis.photos[photoIndex];
                        if (!photo) return null;
                        return (
                          <div key={photoIndex} style={{ position: 'relative' }}>
                            <button
                              className={`photo-tile${movingPhoto === photoIndex ? ' primary' : ''}`}
                              title={`${photo.originalFilename}\nClick to move, or split out below`}
                              onClick={() => setMovingPhoto(movingPhoto === photoIndex ? null : photoIndex)}
                            >
                              {/* These files aren't in the media library yet,
                                  and the renderer can't read arbitrary disk
                                  paths -- the preview came over with the
                                  analysis. */}
                              <img src={photo.thumbnail} alt="" />
                              {photo.duplicateOfItemId && <span className="photo-tile-badge">already added</span>}
                            </button>
                            {group.length > 1 && movingPhoto === null && (
                              <button
                                className="btn-link"
                                style={{ fontSize: 11, marginTop: 2 }}
                                onClick={() => splitPhoto(groupIndex, photoIndex)}
                              >
                                split out
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="field-inline" style={{ marginTop: 16 }}>
                <input
                  id="auto-process"
                  type="checkbox"
                  checked={autoProcess}
                  onChange={(event) => setAutoProcess(event.target.checked)}
                />
                <label htmlFor="auto-process">Start identifying and valuing straight away</label>
              </div>

              {error && <div className="banner banner-bad">{error}</div>}

              <div className="modal-actions">
                <button className="btn" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => void commit()} disabled={busy}>
                  {busy ? 'Adding…' : `Add ${groups.length} ${groups.length === 1 ? itemNoun : `${itemNoun}s`}`}
                </button>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
