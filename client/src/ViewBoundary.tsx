import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The blast wall around a tab.
 *
 * React unmounts the ENTIRE tree when a component throws and nothing catches it, so one bad read
 * inside one tab painted the whole window white — no message, no navigation, no way back. That is
 * exactly what happened when a response field the client's types still promised stopped being sent:
 * `data.savings.insideTotal` threw, and the app disappeared.
 *
 * A crash in one tab is now a card in that tab. The rest of the app keeps working, and the error
 * text is on screen instead of only in a console the household will never open.
 *
 * Keyed by view in App, so navigating away resets it: a new key is a new instance, which is what
 * lets a broken tab recover the moment its data does.
 */
export class ViewBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // the stack is the only thing that names the culprit — it belongs somewhere retrievable
    console.error('[view crashed]', error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="card tone-coral crash-card">
        <div className="label">משהו נשבר במסך הזה</div>
        <p>
          שאר האפליקציה עובדת — אפשר לעבור לטאב אחר ולחזור. הנתונים שלך לא נפגעו: מסגרת רק קוראת
          אותם כאן.
        </p>
        <p>אם זה חוזר, שלח את השורה הזאת:</p>
        <pre className="crash-detail">{this.state.message}</pre>
        {/* the app's default button, not `.primary`: measured 3.2:1 in dark, because some rule
            paints a subset of primary buttons white over the accent gradient (visible on the
            connections tab too — two primaries, two different inks). Not this card's fight. */}
        <button onClick={() => window.location.reload()}>טעינה מחדש</button>
      </div>
    );
  }
}
