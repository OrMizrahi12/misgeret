import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessageHe, errorTypeHe } from './api';
import { CompanyLogo } from './CompanyLogo';
import { desktop } from './desktop';
import { ConnectionsCoach } from './Onboarding';
import type { Company, CompanyOutage, Connection } from './types';

const KIND_LABELS: Record<string, string> = { bank: 'בנקים', card: 'כרטיסי אשראי', other: 'אחר' };

/** How far back this institution actually goes. Every scraper clamps its own start date, so the
 *  window we ask for and the window we get are two different numbers — this is the second one. */
const HISTORY_HE: Record<number, string> = {
  3: 'שלושה חודשים',
  6: 'חצי שנה',
  12: 'שנה',
  18: 'שנה וחצי',
  24: 'שנתיים',
};

function historyHe(months: number): string {
  return HISTORY_HE[months] ?? `${months} חודשים`;
}

function monthYearHe(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/** A breakage on the institution's side, said out loud. Without this the app lets a person wait out
 *  a ten-minute timeout and then tells them to "try again in a few minutes" — which is not merely
 *  unhelpful, it is wrong: retrying cannot work until the library catches up with the bank.
 *  No link out: the desktop bridge only opens our own site, and a dead button is worse than none. */
function OutageNote({ outage, nameHe }: { outage: CompanyOutage; nameHe: string }) {
  return (
    <div className="outage-note">
      <AlertTriangle size={17} strokeWidth={2.2} aria-hidden />
      <div>
        <strong>{nameHe} — תקלה ידועה מאז {monthYearHe(outage.since)}</strong>
        <p>{outage.noteHe}</p>
      </div>
    </div>
  );
}

export function Connections({ onBack }: { onBack: () => void }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<{ company: Company; connection?: Connection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);

  async function load() {
    const [comps, conns] = await Promise.all([api.companies(), api.connections()]);
    setCompanies(comps);
    setConnections(conns);
  }

  useEffect(() => {
    load().catch((e) => setError(errorMessageHe(e)));
  }, []);

  async function syncAll() {
    setSyncing(true);
    setError(null);
    setSyncSummary(null);
    try {
      const res = await api.sync();
      const ok = res.results.filter((r) => r.success);
      const added = ok.reduce((s, r) => s + r.added, 0);
      setSyncSummary(`סונכרנו ${ok.length}/${res.results.length} חיבורים · ${added} עסקאות חדשות`);
      await load(); // per-connection last-sync/errors refresh below
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setSyncing(false);
    }
  }

  async function remove(conn: Connection) {
    if (!window.confirm(`למחוק את החיבור "${conn.nickname ?? conn.nameHe}"? כל העסקאות שלו יימחקו.`)) return;
    try {
      await api.deleteConnection(conn.id);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <button className="link" onClick={onBack}>← חזרה לדשבורד</button>
        <span style={{ flex: 1 }} />
        {connections.length > 0 && (
          <button className="primary sync-btn" onClick={syncAll} disabled={syncing}>
            <RefreshCw size={15} strokeWidth={2} className={syncing ? 'spin' : ''} />
            {syncing ? 'מסנכרן הכל…' : 'סנכרון כל החיבורים'}
          </button>
        )}
      </div>
      <h2>חיבורים</h2>
      {syncSummary && <p className="muted" style={{ color: 'var(--positive)' }}>{syncSummary}</p>}
      {error && <p className="error">{error}</p>}
      {/* the new-user coach: what to connect and why — hides once bank + card both exist */}
      {companies.length > 0 && <ConnectionsCoach connections={connections} companies={companies} />}
      <ul className="connections">
        {connections.map((c) => (
          <li key={c.id} className="card connection">
            {/* the institution's own mark — the name still says who it is; the logo just
                lets the eye find it first */}
            <CompanyLogo companyId={c.company} nameHe={c.nameHe} size={44} />
            <div className="connection-body">
              <strong>{c.nickname ?? c.nameHe}</strong>
              {c.nickname && <span className="muted"> · {c.nameHe}</span>}
              <div className="muted">
                {c.lastSyncAt ? `סנכרון אחרון: ${new Date(c.lastSyncAt).toLocaleString('he-IL')}` : 'טרם סונכרן'}
                {` · מושך ${historyHe(c.historyMonths)} אחורה`}
              </div>
              {/* the outage note already explains the failure — a second red line under it would
                  say the same thing twice, in two different voices */}
              {c.outage && <OutageNote outage={c.outage} nameHe={c.nameHe} />}
              {c.lastError && c.lastError !== 'PROVIDER_OUTAGE' && (
                <div className="error-inline">{errorTypeHe(c.lastError)}</div>
              )}
            </div>
            <div className="actions">
              <button
                className="link"
                onClick={() => {
                  const comp = companies.find((x) => x.id === c.company);
                  if (comp) setEditing({ company: comp, connection: c });
                }}
              >
                עדכון פרטים
              </button>
              <button className="link danger" onClick={() => remove(c)}>מחיקה</button>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <ConnectionForm
          company={editing.company}
          connection={editing.connection}
          onDone={() => {
            setEditing(null);
            load().catch((e) => setError(errorMessageHe(e)));
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <AddConnection companies={companies} onPick={(company) => setEditing({ company })} />
      )}
    </div>
  );
}

/** The institutions, face-first. A dropdown asks you to remember which bank you use; a wall
 *  of real marks asks you to recognise it — recognition beats recall, and these are exactly
 *  the logos on the cards in your wallet. */
function AddConnection({ companies, onPick }: { companies: Company[]; onPick: (c: Company) => void }) {
  const kinds: Company['kind'][] = ['bank', 'card', 'other'];
  return (
    <div className="add-connection">
      <h3 style={{ margin: 0 }}>הוספת חיבור</h3>
      {kinds.map((k) => {
        const list = companies.filter((c) => c.kind === k);
        if (list.length === 0) return null;
        return (
          <div key={k}>
            <div className="company-kind-label">{KIND_LABELS[k]}</div>
            <div className="company-tiles" role="list">
              {list.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={c.outage ? 'company-tile has-outage' : 'company-tile'}
                  role="listitem"
                  onClick={() => onPick(c)}
                >
                  <CompanyLogo companyId={c.id} nameHe={c.nameHe} size={40} />
                  <span className="company-tile-name">{c.nameHe}</span>
                  {/* the warning belongs on the tile, not only after the attempt — the whole point
                      is to reach a person BEFORE they spend ten minutes waiting */}
                  {c.outage && (
                    <span className="company-tile-warn" title="תקלה ידועה — לחץ לפרטים">
                      <AlertTriangle size={14} strokeWidth={2.4} aria-label="תקלה ידועה" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConnectionForm({
  company,
  connection,
  onDone,
  onCancel,
}: {
  company: Company;
  connection?: Connection;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [nickname, setNickname] = useState(connection?.nickname ?? '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = desktop;
    if (!bridge) return;
    void bridge.setUnsavedChanges(true).catch(() => {});
    return () => {
      void bridge.setUnsavedChanges(false).catch(() => {});
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (connection) {
        await api.updateConnection(connection.id, { nickname: nickname.trim(), credentials: fields });
      } else {
        await api.addConnection({ company: company.id, nickname: nickname.trim() || undefined, credentials: fields });
      }
      onDone();
    } catch (err) {
      setError(errorMessageHe(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="connection-form-head">
        <CompanyLogo companyId={company.id} nameHe={company.nameHe} size={44} />
        <h3>{connection ? `עדכון פרטים — ${company.nameHe}` : `חיבור חדש — ${company.nameHe}`}</h3>
      </div>
      {company.outage && <OutageNote outage={company.outage} nameHe={company.nameHe} />}
      <p className="muted">הפרטים נשמרים מוצפנים על המחשב הזה בלבד, באמצעות מנגנון האבטחה של מערכת ההפעלה, ומשמשים אך ורק להתחברות לאתר המוסד.</p>
      {/* Said here, where the expectation is formed. Anything under a year is a surprise worth
          colouring: Yahav hands back three months and no surface used to admit it. */}
      <p className={company.historyMonths < 12 ? 'history-note short' : 'history-note'}>
        {`${company.nameHe} נותן ${historyHe(company.historyMonths)} אחורה — זו כל ההיסטוריה שאפשר למשוך ממנו.`}
      </p>
      <label>
        כינוי (אופציונלי)
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder={company.nameHe} />
      </label>
      {company.loginFields.map((f) => (
        <label key={f.name}>
          {f.labelHe}
          <input
            type={f.secret ? 'password' : 'text'}
            value={fields[f.name] ?? ''}
            onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
            required
          />
        </label>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={saving}>{saving ? 'שומר…' : 'שמירה'}</button>
        <button type="button" className="link" onClick={onCancel}>ביטול</button>
      </div>
    </form>
  );
}
