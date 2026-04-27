# design.md — Slashtalk UI style guide

> **Status: v1 (binding).** This is the source of truth for any UI under `apps/desktop/src/renderer/**`. Token implementations live in [`src/renderer/shared/tailwind.css`](../src/renderer/shared/tailwind.css); component implementations live in [`src/renderer/shared/Button.tsx`](../src/renderer/shared/Button.tsx) and the rest of `shared/`. **Update this file in the same commit** as any change to either.

If a need can't be expressed with what's defined here, the answer is to update this file and the tokens — not to one-off it in JSX.

---

## 1. First principles

1. **Tokens, never literals.** No raw hex, rgba, px sizes, or arbitrary spacings in JSX. Tokens are defined in `tailwind.css`; if one is missing, add it there.
2. **Theme-agnostic.** Tokens swap automatically between dark, light, and system. **Never** write `dark:` variants.
3. **Three button variants. One icon library. One type scale. One spacing scale.** Resist drift.
4. **Reuse before invent.** If a button, surface, badge, or input already exists for the role, use it. Variations dilute the system.

---

## 2. Color

We follow the **60 / 30 / 10** rule per theme:

- **60% — neutrals (backgrounds).** `bg`, `surface`, `surface-2`. Most pixels.
- **30% — secondary surfaces / borders / chrome.** `surface-alt`, `border`, `divider`, `muted` text.
- **10% — accent.** Slashtalk green. Used sparingly for primary actions, focus, and active states.

Semantic feedback colors (`success`, `danger`, `warning`, `info`) are **separate** from the brand palette and reserved for status communication only — never as decorative accents.

### 2.1 Tokens

#### Neutrals (60%)

| Token        | Role                                        |
| ------------ | ------------------------------------------- |
| `bg`         | Window / page background                    |
| `surface`    | Default container (cards, panels)           |
| `surface-2`  | Elevated surface (popover, modal)           |

#### Secondary (30%)

| Token            | Role                                                       |
| ---------------- | ---------------------------------------------------------- |
| `surface-alt`    | Alternate surface inside a card (rows, sub-cards, inputs)  |
| `surface-alt-hover` | Hover state for `surface-alt`                           |
| `border`         | All 1px borders                                            |
| `divider`        | Hairline rules (`h-px`)                                    |
| `text-fg`        | Primary text                                               |
| `text-muted`     | Secondary text                                             |
| `text-subtle`    | Tertiary text (captions, timestamps, placeholders)         |

#### Primary (10%)

| Token             | Role                                                    |
| ----------------- | ------------------------------------------------------- |
| `primary`         | Slashtalk green — primary action background             |
| `primary-hover`   | Hover state for `primary`                               |
| `primary-fg`      | Foreground on `primary` (white)                         |
| `primary-soft`    | `primary` at low opacity — for active toggles, badges   |

#### Semantic feedback

| Token       | Color  | Use                                        |
| ----------- | ------ | ------------------------------------------ |
| `success`   | green  | Confirmed / connected / positive state     |
| `danger`    | red    | Error / destructive action                 |
| `warning`   | yellow | Caution / non-blocking warning             |
| `info`      | blue   | Neutral information / live indicator       |

`success` shares a hue family with `primary` but is a distinct token — keep them separate so feedback never looks like a CTA and vice versa.

### 2.2 Opacity modifiers

Tailwind's `/NN` modifier works on every token: `text-fg/60`, `bg-surface/40`, `border-success/70`. Always prefer this over creating a new token for "the same color but lighter".

### 2.3 Theming

Three modes — `dark`, `light`, `system` — managed by `setThemeMode()` in [`shared/theme.ts`](../src/renderer/shared/theme.ts). Tokens are CSS variables; switching themes swaps the values, no re-render needed.

When you add a token, update **three blocks** in `tailwind.css` in the same edit:

1. `@theme` (dark default)
2. `:root.theme-light` override
3. `@media (prefers-color-scheme: light)` fallback (mirrors block 2 byte-for-byte)

The two light blocks must stay identical. Forgetting block 3 ships a broken light mode for users without an explicit override.

---

## 3. Typography

### 3.1 Family

- **Body & UI:** Inter (loaded via `tailwind.css`). Fallback chain: `Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`.
- **Mono:** `ui-monospace, "SF Mono", Menlo, monospace`. For code, file paths, repo/branch chips, API keys.

### 3.2 Scale

**Seven sizes — that's the whole vocabulary.** Use the named utility, not arbitrary `text-[Npx]`.

| Token       | Size  | Use                                                       |
| ----------- | ----- | --------------------------------------------------------- |
| `text-xs`   | 11px  | Eyebrow labels, status pills, captions                    |
| `text-sm`   | 12px  | Helper text, secondary meta                               |
| `text-base` | 13px  | **Default body.** Buttons, inputs, list rows              |
| `text-md`   | 15px  | Prominent body — chat input, response markdown body       |
| `text-lg`   | 18px  | Sub-section title, popover header name                    |
| `text-xl`   | 22px  | Section title, response markdown h1                       |
| `text-2xl`  | 28px  | Window-level title (sign-in, main header)                 |

11px is the floor. Anything smaller fails accessibility and is forbidden.

### 3.3 Weight

- `font-normal` (400) — default body
- `font-medium` (500) — buttons, list-row titles, emphasized labels
- `font-semibold` (600) — section headings, eyebrow labels, strong action buttons
- `font-bold` (700) — window-level titles only

No other weights.

### 3.4 Tracking & leading

- `tracking-tight` — `text-xl` and `text-2xl` titles
- `tracking-wider` + `uppercase` — eyebrow labels (`text-xs`)
- Default tracking — everything else
- `leading-tight` — large titles
- `leading-snug` — compact paragraphs and helper text
- `leading-relaxed` — long-form markdown

No arbitrary `tracking-[…]` values.

---

## 4. Spacing

**One scale — Tailwind's default 4px-per-unit numeric scale.**

`p-1` = 4px, `p-2` = 8px, `p-3` = 12px, `p-4` = 16px, `p-6` = 24px, `p-8` = 32px. The half-step (`p-2.5` = 10px, `p-3.5` = 14px) is allowed for fine-tuning.

We do **not** use a t-shirt-named alias scale. If you see `px-lg`, `gap-md`, etc. in old code, migrate it.

The root is pinned to `--spacing: 4px` so the scale is the same regardless of `font-size`.

---

## 5. Radii

| Token         | Use                                                              |
| ------------- | ---------------------------------------------------------------- |
| `rounded-md`  | Small chips, inline tags                                         |
| `rounded-lg`  | Buttons, inputs, list rows                                       |
| `rounded-xl`  | Sub-cards, framed callouts                                       |
| `rounded-2xl` | Top-level cards / sections                                       |
| `rounded-3xl` | Popover containers (info window)                                 |
| `rounded-full`| Avatars, pills, round icon buttons (dock)                        |

---

## 6. Elevation & shadows

Shadows are a **structural** signal — they communicate that a thing floats above its container. Reserve them for things that genuinely do.

**Allowed:**

- **Windows.** macOS paints these natively (vibrancy + `setMacCornerRadius`). Don't add CSS shadows.
- **Dock / rail.** A subtle shadow under the floating bubble rail.
- **Cards.** A soft shadow on top-level `surface-2` containers (popovers, modals) when they sit above the page.

**Not allowed:**

- Buttons, inputs, badges, list rows, sub-cards inside a card. These get depth from `border` + surface tokens, not shadows.

Token: `shadow-card` (defined in `tailwind.css`) — the only shadow you should reach for. If you need something different, update this section first.

---

## 7. Iconography

**We use [Heroicons](https://heroicons.com)** (`@heroicons/react`) for all generic icons. Two sizes:

- **24px outline** (`@heroicons/react/24/outline`) — default, used at `w-5 h-5` (20px) or `w-6 h-6` (24px)
- **20px mini** (`@heroicons/react/20/solid`) — small inline contexts, used at `w-4 h-4` (16px)

```tsx
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

<MagnifyingGlassIcon className="w-5 h-5 text-fg" />
```

Always use `currentColor` (Heroicons does this by default) and color via `text-*`. Always provide `aria-hidden` unless the icon carries the only label.

### 7.1 Brand & provider marks

Three icons stay custom in [`shared/icons.tsx`](../src/renderer/shared/icons.tsx) because they're brand assets, not UI glyphs:

- `SlashtalkLogo` — three dots on green gradient
- `ClaudeIcon` — Claude wordmark glyph
- `OpenAIIcon` — OpenAI wordmark glyph
- `SpotifyIcon` — Spotify mark (uses real brand green, not our `success` token)

Don't add domain-specific glyphs (a custom branch icon, etc.) unless Heroicons genuinely doesn't cover the concept.

---

## 8. Buttons

**Three variants. That's it.** All are implemented in [`shared/Button.tsx`](../src/renderer/shared/Button.tsx) — import and use, do not roll your own.

### 8.1 `<Button variant="primary">`

The principal action. Slashtalk green, white foreground.

- One per visible viewport (a form, a section, a dialog).
- Used for: `Sign in`, `Create agent`, `Send`, `Save`.

### 8.2 `<Button variant="secondary">`

Everything else. Neutral surface, default text, 1px border.

- Default for any non-primary action.
- Used for: `Add local repo`, `Cancel`, `+ New agent`, `Refresh`.

### 8.3 `<Button variant="ghost">`

Text-only — no fill, no border. For low-emphasis or inline actions.

- Used for: `Sign out`, row dismiss `×`, "Show all", link-style affordances.

### 8.4 Icon support

All variants accept an icon prop and a label. **Every button can be icon-only, icon + text, or text-only.**

```tsx
<Button variant="primary" icon={<PaperAirplaneIcon className="w-4 h-4" />}>
  Send
</Button>

<Button variant="secondary" icon={<PlusIcon className="w-4 h-4" />}>
  Add local repo
</Button>

<Button variant="ghost" icon={<XMarkIcon className="w-4 h-4" />} aria-label="Remove" />
```

### 8.5 Round icon button (`<Button variant="primary" round>` etc.)

The dock / rail / chat composer's pill-shaped icon buttons. Same three variants, just `round` for `rounded-full` and forced equal `w` × `h`.

```tsx
<Button variant="primary" round size="lg" icon={<PaperAirplaneIcon className="w-5 h-5" />} aria-label="Send" />
```

### 8.6 Sizes

| `size`  | Height | Padding (text variant) | Use                                    |
| ------- | ------ | ---------------------- | -------------------------------------- |
| `sm`    | 28px   | `px-3 py-1.5`          | Inline header actions, dense forms     |
| `md`    | 36px   | `px-4 py-2`            | **Default.** Most buttons              |
| `lg`    | 44px   | `px-5 py-2.5`          | Primary CTAs in sign-in / hero         |

For round buttons: `sm` = 32px, `md` = 40px, `lg` = 44px (matches the chat composer's existing geometry).

### 8.7 States

- **Hover** — primary: slight darken via `bg-primary-hover`. Secondary/ghost: `bg-surface-alt-hover`.
- **Active** — `active:scale-[0.98]` for tactile feedback. No other treatments.
- **Disabled** — `opacity-50 cursor-not-allowed`. Applies to all variants identically. **Never** style a separate "disabled variant" — the `disabled` HTML attribute is the source of truth.
- **Loading** — same as disabled, plus swap label to a verb-progressive ("Saving…", "Sending…"). No spinner inside the button.

### 8.8 Forbidden

- **No shadows on buttons.** Ever.
- **No bespoke gradient buttons.** The Slashtalk gradient lives on the `primary` token's underlying value; if we ever want it back as a flourish, update the token, not the button.
- **No "danger" or "success" button variant.** Use `ghost` with `text-danger` if you need a destructive text action; use `primary` for confirmation. Color carries the only role distinction.

---

## 9. Surfaces

### 9.1 Cards (top-level section)

```tsx
<section className="bg-surface rounded-2xl p-4">…</section>
```

Header row inside a card: `flex items-center gap-2 mb-3`. Title is `text-base font-semibold` (h2), subtitle below is `text-sm text-subtle`. Trailing actions go to `ml-auto`.

### 9.2 Sub-cards / framed callouts

```tsx
<div className="bg-surface-alt border border-border rounded-xl p-3">…</div>
```

Used for forms, "step N" panels, MCP server lists, anything that nests one level inside a card.

### 9.3 List rows

Inside a card, a row of items uses `surface-alt`:

```tsx
<div className="flex items-center gap-3 px-3 py-2 bg-surface-alt rounded-lg">…</div>
```

The hover treatment is `hover:bg-surface-alt-hover`. For an interactive (clickable) row, add `cursor-pointer`.

### 9.4 Popovers / windows

The info popover uses `bg-surface-2 rounded-3xl`. Vibrancy is painted natively; CSS just sets the fallback color.

---

## 10. Form components

### 10.1 `Field` wrapper (label + control)

Canonical label-above-control wrapper. Source: [`AgentsSection.tsx`](../src/renderer/main/AgentsSection.tsx).

```tsx
<Field label="Name">
  <input … />
</Field>
```

The label is `text-xs font-semibold uppercase tracking-wider text-subtle mb-1`.

### 10.2 Text input / textarea

```tsx
className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary"
```

Textarea adds `resize-none leading-snug` plus `rows={N}`.

### 10.3 Bare input (chat composer)

```tsx
className="flex-1 min-w-0 bg-transparent border-none outline-none text-md text-fg placeholder:text-subtle"
```

For chrome-less inputs embedded in a transparent surface.

### 10.4 Toggle (`<Toggle>` / segmented)

For a small fixed set of mutually exclusive options (Cloud/Local, Private/Team), use the `Toggle` component (renamed from `ModeButton`). Active state uses `primary-soft`:

```tsx
<Toggle active={mode === "cloud"} onClick={…}>Cloud</Toggle>
```

Implementation: bordered pill, `text-sm px-3 py-1 rounded-md`. Active: `bg-primary-soft border-primary text-primary`.

---

## 11. Pills, chips, and badges

| Shape                                                                                                       | Use                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `text-xs uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-border text-muted`              | Status tag (Agent, Cloud, private)               |
| `text-xs px-2 py-0.5 rounded-full bg-surface-alt hover:bg-surface-alt-hover border border-border`          | Selectable chip (templates, repo pills, presets) |
| `inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 rounded bg-surface-alt/70 text-fg/75`      | Repo / branch locator                            |

Step badges (numbered indicators) use `w-5 h-5 rounded-full bg-surface-alt text-subtle`; success state swaps to `bg-success/15 text-success`.

---

## 12. Dividers

```tsx
<div className="h-px bg-divider" />
```

Always 1px, always `bg-divider`. Add `mx-4` (or matching) to indent past container padding.

---

## 13. Avatars

```tsx
<span className="rounded-full inline-flex items-center justify-center overflow-hidden shrink-0" style={{ background: head.tint }}>
  {emoji or <img className="w-full h-full rounded-full object-cover" />}
</span>
```

Sizes: `w-6 h-6` (list rows), `w-7 h-7` (agent chip), `w-12 h-12` (popover header). Tint stays inline (`style.background`) since it's data-driven.

---

## 14. Animation

- **Transitions.** Always property-specific: `transition-colors`, `transition-[opacity,transform]`, `transition-[filter]`. **Never** `transition-all`.
- **Durations.** `duration-75` (popover fade), `duration-150` (default hover/scale).
- **Easing.** `ease-out` for entrances and hovers. Default for the rest.
- **Hover scale.** `hover:scale-[1.03]` is the only allowed scale value for hover affordance.
- **Active scale.** `active:scale-[0.98]` for buttons (tactile feedback).
- **Custom keyframes.** Two: `shimmer-char` (working-now text) and `live-ring` (rail chathead pulse). Don't add a third without tying into one of those signals.

---

## 15. Anti-patterns

1. **Arbitrary hex/rgba/px in JSX.** Tokens only.
2. **`dark:` variants.** We swap via CSS variables.
3. **`transition-all`.** Always property-specific.
4. **Bespoke buttons.** Three variants. Use `Button.tsx`. If your case doesn't fit, update this doc first.
5. **Button shadows.** No.
6. **New typography sizes.** Seven scale stops. If a design needs something else, round to the nearest stop.
7. **T-shirt spacing aliases.** `px-md`, `gap-lg`, etc. are dead. Use numeric.
8. **Domain-specific custom icons** when Heroicons covers it.
9. **Skipping the light-theme block** when adding a color token.

---

## 16. When to update this file

In the **same commit** as the code change, every time you:

- Add or rename a token in `tailwind.css`
- Add a button size, variant, surface, badge shape, or input style not covered here
- Change a canonical class string for an existing component
- Retire a pattern (mark it removed, point to the replacement)

If you find yourself wanting to break a rule here, that's a signal — either change the rule (and update this file) or rethink the design. Both are valid; silent drift is not.
