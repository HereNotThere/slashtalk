import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render as a circular icon button. Forces equal width and height. */
  round?: boolean;
  /** Optional leading icon. Sized at the call site. */
  icon?: ReactNode;
  /** Stretch to fill the parent's width. */
  fullWidth?: boolean;
  /** Visible label. Optional for `round` icon-only buttons (use aria-label). */
  children?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary: "bg-surface-alt text-fg border border-border hover:bg-surface-alt-hover",
  ghost: "bg-transparent text-fg hover:bg-surface-alt",
};

const SIZE_TEXT: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-xs",
  md: "h-9 px-4 text-base",
  lg: "h-11 px-5 text-base",
};

const SIZE_ROUND: Record<ButtonSize, string> = {
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-11 w-11",
};

export function Button({
  variant = "secondary",
  size = "md",
  round = false,
  icon,
  fullWidth = false,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps): JSX.Element {
  const base =
    "inline-flex items-center justify-center gap-2 font-medium cursor-pointer " +
    "transition-colors duration-150 ease-out active:scale-[0.98] " +
    "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";

  const shape = round ? `rounded-full ${SIZE_ROUND[size]}` : `rounded-lg ${SIZE_TEXT[size]}`;
  const width = !round && fullWidth ? "w-full" : "";

  const classes = [base, VARIANT[variant], shape, width, className].filter(Boolean).join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/** Two-state toggle pill (formerly ModeButton). For mutually-exclusive
 * options like Cloud/Local, Private/Team. */
export function Toggle({
  active,
  disabled = false,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  const base =
    "text-sm px-3 py-1 rounded-md border transition-colors duration-150 ease-out cursor-pointer";
  const state = disabled
    ? "bg-surface-alt/50 border-border text-subtle cursor-not-allowed opacity-60"
    : active
      ? "bg-primary-soft border-primary text-primary"
      : "bg-surface-alt border-border text-fg hover:bg-surface-alt-hover";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${state}`}
    >
      {children}
    </button>
  );
}
