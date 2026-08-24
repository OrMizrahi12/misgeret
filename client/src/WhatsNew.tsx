import { Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import type { WhatsNewEntry } from './release-notes';

/** The after-update popup: "מסגרת התעדכנה — הנה מה שהשתנה". Closes on the button,
 *  the backdrop, or Escape; the caller records the version as seen on close. */
export function WhatsNewModal({ entries, version, onClose }: {
  entries: WhatsNewEntry[];
  version: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wn-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`מה חדש במסגרת ${version}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wn-head">
          <span className="wn-head-icon" aria-hidden="true"><Sparkles size={17} strokeWidth={2} /></span>
          <span className="wn-head-text">
            <span className="wn-title">מסגרת התעדכנה</span>
            <span className="wn-sub">גרסה {version} · הנה מה שהשתנה</span>
          </span>
        </div>
        {entries.map((e) => (
          <div className="wn-entry" key={e.version}>
            <div className="wn-entry-head">
              <span className="wn-entry-title">{e.title}</span>
              <span className="wn-entry-ver">{e.version}</span>
            </div>
            <ul className="wn-list">
              {e.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        ))}
        <div className="wn-actions">
          <button className="primary" onClick={onClose}>מעולה, תודה</button>
        </div>
      </div>
    </div>
  );
}
