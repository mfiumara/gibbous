import type { ReactNode } from 'react';

export const Section = ({ title, description, children, aside }: { title: string; description?: ReactNode; children?: ReactNode; aside?: ReactNode }) => (
  <section className="surface rounded-2xl p-5 space-y-4">
    {/* Phones: the actions go under the description instead of squeezing it into a column. */}
    <div className="flex flex-col sm:flex-row sm:items-start gap-3">
      <div className="flex-1 min-w-0 space-y-1"><h2 className="font-bold text-[15px]">{title}</h2>{description && <p className="text-[13px] text-dust">{description}</p>}</div>
      {aside && <div className="flex-none flex flex-wrap gap-2">{aside}</div>}
    </div>
    {children}
  </section>
);

export const Row = ({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 border-t border-line first:border-t-0">
    <div className="flex-1 min-w-[min(13rem,100%)]"><p className="text-sm">{title}</p>{description && <p className="text-xs text-dust mt-0.5">{description}</p>}</div>
    <div className="flex-none">{children}</div>
  </div>
);
