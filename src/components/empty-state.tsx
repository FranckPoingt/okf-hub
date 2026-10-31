import type { ReactNode } from "react";

export function EmptyState(
  { icon, title, description, children, className = "" }: {
    icon: ReactNode;
    title: string;
    description?: ReactNode;
    children?: ReactNode;
    className?: string;
  },
) {
  return (
    <div className={`px-6 py-14 text-center ${className}`}>
      <span className="mx-auto flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-5">
        {icon}
      </span>
      <h2 className="mt-3 text-base font-semibold">{title}</h2>
      {description && (
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {children && <div className="mt-4 flex justify-center">{children}</div>}
    </div>
  );
}
