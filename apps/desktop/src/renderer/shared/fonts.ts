/**
 * Inter font, bundled into the renderer. Imported for its side effects (each
 * `@fontsource/inter/<weight>.css` file `@font-face`-declares that weight).
 *
 * Weights here must match the ones we actually use — see `docs/design.md` §3.3.
 * Adding a weight to the design system means adding the import here too.
 */
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
// Instrument Serif italic — used as the accent face on the onboarding /
// sign-in screens to mirror the marketing site. Only the italic 400 is
// loaded; we never use the upright cut.
import "@fontsource/instrument-serif/400-italic.css";
