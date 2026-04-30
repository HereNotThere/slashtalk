/** Round avatar with a colored-initial fallback when no remote URL is
 *  available (external PR authors, accounts without a stored avatar). */
export function PersonAvatar({
  person,
  size,
}: {
  person: { login: string; avatarUrl: string | null };
  size: number;
}): JSX.Element {
  if (person.avatarUrl) {
    return (
      <img
        src={person.avatarUrl}
        alt=""
        width={size}
        height={size}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  const initial = person.login.slice(0, 1).toUpperCase();
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-surface-alt text-fg/80 font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.45) }}
      aria-hidden
    >
      {initial}
    </span>
  );
}
