import type { LucideIcon } from 'lucide-react';

/** One concentrated drop of the card's identity colour — the rounded icon chip that sits
 *  top-center above a card's statement title. Purely decorative; the title carries meaning. */
export function CardChip({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="card-chip" aria-hidden="true">
      <Icon size={22} strokeWidth={2} />
    </div>
  );
}
