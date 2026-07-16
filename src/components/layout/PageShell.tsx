import type { PropsWithChildren } from 'react';
import { cn } from '@/utils/cn';

type PageShellProps = PropsWithChildren<{
  className?: string;
}>;

export function PageShell({ className, children }: PageShellProps) {
  return (
    <main
      className={cn(
        'app-page-shell min-h-screen bg-app-bg text-app-fg transition-colors duration-200',
        className,
      )}
    >
      {children}
    </main>
  );
}

export function AuthCard({ className, children }: PageShellProps) {
  return (
    <div
      className={cn(
        'app-auth-card w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-8 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_20px_40px_rgba(0,0,0,0.35)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
