<!--
Template: runbook — operational recovery procedure.
Place this file at: docs/runbooks/<topic>.md (kebab-case).
A runbook is written when a failure mode is encountered for the second
time. The first occurrence is an incident; the second proves the failure
is recurring and worth a documented procedure.
Replace every <placeholder>. Delete this comment block before committing.
After writing, link the new runbook from docs/README.md under Runbooks.
-->

# <Failure mode> runbook

<One paragraph: what does this failure mode look like in production, what's the user-visible impact, why does it happen.>

## Symptoms

<What you see when this is happening. Be specific.>

- <Log line, alert, or metric pattern that signals this failure>
- <User-visible symptom (if any)>
- <Downstream effect — what stops working>

## Immediate response

<Steps to stop the bleeding. Numbered, ordered, terse. Each step should be a single command or a single decision.>

1. <Step 1, e.g., "Check Redis connectivity: `redis-cli -u $REDIS_URL ping`">
2. <Step 2>
3. <Step 3 — verify recovery>

## Root cause investigation

<Where to look once the immediate response has stabilized things.>

- **Logs:** <which logs, what to grep for>
- **Metrics:** <which dashboard, which series>
- **Code paths:** <which files are most likely involved>

## Long-term fix

<The structural change that would prevent this from recurring. If a tech-debt-tracker.md item exists, link it. If not, this runbook should produce a tech-debt-tracker entry as a side effect.>

- Tracked in: [`tech-debt-tracker.md` § <item N>](../exec-plans/tech-debt-tracker.md)
- Owner: <name or "unassigned">

## Related incidents

<Append-only log of when this runbook has been used. Append; never rewrite.>

- <YYYY-MM-DD>: <one-line description, optional link to PR or postmortem>
