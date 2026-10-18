import type { ReactNode } from 'react';

export interface PanelState {
  loading?: boolean;
  /** shown with role="alert"; wins over loading and content */
  error?: string | null;
}

/** Shared shell: heading, then error, loading, empty or the content. */
export function Panel({
  title,
  className,
  loading,
  error,
  empty,
  emptyText,
  children,
}: PanelState & {
  title: string;
  className?: string;
  empty?: boolean;
  emptyText?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={`nd-panel${className ? ` ${className}` : ''}`}
      aria-label={title}
      aria-busy={loading ? true : undefined}
    >
      <h3 className="nd-panel-title">{title}</h3>
      {error ? (
        <p className="nd-error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="nd-loading" role="status">
          Loading {title.toLowerCase()}…
        </p>
      ) : empty ? (
        <p className="nd-empty">{emptyText ?? 'Nothing to show yet.'}</p>
      ) : (
        children
      )}
    </section>
  );
}
