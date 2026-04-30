interface AvatarProps {
  src: string | null | undefined;
  login: string;
  size?: number;
  className?: string;
}

export function Avatar({ src, login, size = 38, className = "" }: AvatarProps): JSX.Element {
  const style = { width: size, height: size };
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={`flex-none rounded-full bg-surface-alt object-cover ${className}`}
        style={style}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className={`flex flex-none items-center justify-center rounded-full bg-surface-alt font-bold text-fg ${className}`}
      style={style}
    >
      {login.slice(0, 1).toUpperCase()}
    </div>
  );
}
