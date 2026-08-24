import { ChevronLeft } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Keep the default surface concise and move the complete explanation into a focused dialog.
 * The portal targets <body> because a transformed card would otherwise become the containing
 * block for position:fixed and trap the backdrop inside the card.
 */
export function DetailModal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal detail-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <span className="detail-modal-title">{title}</span>
          <button className="detail-modal-close" onClick={onClose} aria-label="סגירה">✕</button>
        </div>
        <div className="detail-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The one affordance the clean surface keeps: the door to the full story. */
export function DetailButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="detail-row">
      <button className="detail-btn" onClick={onClick}>
        פירוט מלא <ChevronLeft size={14} strokeWidth={2.2} className="ic" aria-hidden />
      </button>
    </div>
  );
}
