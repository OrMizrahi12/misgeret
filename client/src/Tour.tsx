import {
  CalendarHeart, CalendarRange, ChevronLeft, ChevronRight, Compass, HeartPulse, Home as HomeIcon, PiggyBank,
  RefreshCw, Repeat, ShieldCheck, Telescope, TrendingUp, Wallet,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { markTourDone } from './Onboarding';

interface TourStep {
  icon: ReactNode;
  title: string;
  text: string;
}

/** One minute, the whole app: a step per destination, in the sidebar's own order and icons. */
const STEPS: TourStep[] = [
  {
    icon: <HomeIcon size={22} strokeWidth={1.9} />,
    title: 'הבית',
    text: 'הצומת של מסגרת: כרטיסייה צבעונית לכל אזור. מכאן נכנסים לכל דבר בלחיצה — ותמיד אפשר לחזור דרך "הבית" בתפריט הצד.',
  },
  {
    icon: <CalendarHeart size={22} strokeWidth={1.9} />,
    title: 'איך אני החודש?',
    text: 'ההווה: כמה נכנס, כמה יצא, וכמה בטוח להוציא עד סוף החודש. כאן גם מסווגים עסקאות — וכל סיווג מלמד את מסגרת לזהות לבד בפעם הבאה.',
  },
  {
    icon: <Compass size={22} strokeWidth={1.9} />,
    title: 'התוכנית שלי',
    text: 'ההגדרה האחת של הבית: באיזה אחוז מההכנסה אתה רוצה לסגור כל חודש. ממנה נגזר הכול — כמה נשאר להוציא בבטחה, ומה נחשב חריגה. זה כל מה שצריך להגדיר.',
  },
  {
    icon: <CalendarRange size={22} strokeWidth={1.9} />,
    title: 'איך עברה השנה?',
    text: 'הדוח השנתי: שנים־עשר חודשים בשורה אחת, הקטגוריות של השנה מול השנה שעברה, והרכישות הגדולות — גם כאלה שנפרסו לתשלומים.',
  },
  {
    icon: <TrendingUp size={22} strokeWidth={1.9} />,
    title: 'איך אני בכללי?',
    text: 'התמונה הגדולה לאורך זמן: כמה נשאר בממוצע כל חודש, פרופיל המינוס, ומפת המנויים והתשלומים — מה שאישרת, ורק מה שאישרת.',
  },
  {
    icon: <Repeat size={22} strokeWidth={1.9} />,
    title: 'מה יורד לי כל חודש?',
    text: 'כל מה שחוזר בכסף שלך, מזוהה אוטומטית: מנויים, חיובים קבועים והרגלים. המערכת מציעה — ואתה פוסק בקליק. שום דבר לא נספר כמחויב בלי אישור שלך.',
  },
  {
    icon: <Telescope size={22} strokeWidth={1.9} />,
    title: 'ומה לגבי העתיד?',
    text: 'תחזית היתרה קדימה, מיושרת מול ההיסטוריה האמיתית שלך — כולל "מה אם" לתרחישים: הוצאה גדולה, חיסכון חודשי, שינוי קצב.',
  },
  {
    icon: <PiggyBank size={22} strokeWidth={1.9} />,
    title: 'חיסכונות',
    text: 'מטרות עם יעד וקצב — והפקדות שנרשמות לבד מהתנועות. כל מטרה בצבע שלה, וההתקדמות נראית בעין.',
  },
  {
    icon: <HeartPulse size={22} strokeWidth={1.9} />,
    title: 'בריאות והון',
    text: 'בריאות פיננסית — ציון אחד עם המדדים שמאחוריו; הון — כל מה שצברת בשורה אחת: חשבונות, חסכונות, נכסים והתחייבויות, לאורך זמן.',
  },
  {
    icon: <RefreshCw size={22} strokeWidth={1.9} />,
    title: 'סנכרון',
    text: 'כפתור הסנכרון למעלה מושך את הנתונים העדכניים מכל החיבורים. מסגרת גם מסנכרנת לבד כשעברו יותר מ־12 שעות.',
  },
  {
    icon: <ShieldCheck size={22} strokeWidth={1.9} />,
    title: 'והכי חשוב: הכול נשאר אצלך',
    text: 'כל הנתונים חיים על המחשב הזה בלבד. אפס ענן, אפס שרתים — הכסף שלך הוא עניין שלך. זהו, אתה מוכן לדרך.',
  },
];

/** The guided tour — a paged modal in the app's own icon language. Closing at any point
 *  marks the tour as done (replay lives in the Home guide and in Settings). */
export function TourModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);

  const close = () => {
    markTourDone();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') setStep((s) => Math.min(STEPS.length - 1, s + 1)); // RTL: left = forward
      if (e.key === 'ArrowRight') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal tour-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`סיור מודרך — שלב ${step + 1} מתוך ${STEPS.length}: ${s.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tour-badge"><Compass size={14} strokeWidth={2.2} aria-hidden="true" />סיור מודרך</div>
        <div className="tour-icon" aria-hidden="true">{s.icon}</div>
        <div className="tour-title">{s.title}</div>
        <p className="tour-text">{s.text}</p>
        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((_, i) => <i key={i} className={i === step ? 'on' : ''} />)}
        </div>
        <div className="tour-nav">
          <button className="link tour-skip" onClick={close}>דלג</button>
          <span className="tour-nav-btns">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)}>
                <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
                הקודם
              </button>
            )}
            {last ? (
              <button className="primary" onClick={close}>סיימנו — לדרך</button>
            ) : (
              <button className="primary" onClick={() => setStep(step + 1)}>
                הבא
                <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
