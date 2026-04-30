/** Eyebrow above each onboarding step's headline. Mirrors the marketing
 *  site's "TEAMMATES / ASK / CONFLICTS" caps + tracked-out style. */
export function StepLabel({ current, total }: { current: number; total: number }): JSX.Element {
  return (
    <div className="text-xs font-medium tracking-[0.18em] uppercase text-subtle">
      Step {current} of {total}
    </div>
  );
}
