import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The transparency law, as a component: every visualization carries a small `?` that
 * opens the EXACT recipe — the formula, where the numbers come from, and what is
 * assumed — in plain Hebrew. "אין ציונים סודיים" applies to arithmetic, not only verdicts.
 */
export function Explain({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="explain-btn"
        aria-label={`איך זה מחושב: ${title}`}
        title="איך זה מחושב? לחיצה פותחת הסבר מלא"
        onClick={() => setOpen(true)}
      >
        ?
      </button>
      {/* portal to <body>: the .view mount animation carries a transform, and a transformed
          ancestor re-anchors position:fixed to ITSELF — the backdrop then covers the whole
          tall page and "center" lands mid-page, below the fold. The body has no transform. */}
      {open && createPortal(
        <div className="modal-backdrop" onClick={() => setOpen(false)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={`איך זה מחושב: ${title}`} onClick={(e) => e.stopPropagation()}>
            <div className="hero-top" style={{ marginBottom: 6 }}>
              <div className="label">איך זה מחושב · {title}</div>
              <button className="link" onClick={() => setOpen(false)}>סגירה ✕</button>
            </div>
            <div className="explain-body">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** A section heading inside the popup — keeps every explainer in the same shape. */
export function ExplainH({ children }: { children: ReactNode }) {
  return <div className="explain-h">{children}</div>;
}

/** The equation itself, boxed — the part the user can redo with a calculator. */
export function Formula({ children }: { children: ReactNode }) {
  return <div className="formula">{children}</div>;
}
