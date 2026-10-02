import type { ReactNode } from 'react';

// The frame every screen outside Suite Manager shares: sign-in, owner setup,
// the terms and the handover. One brand block and one stage, so the next gate
// cannot arrive with its own copy of the header.
export function AuthStage({ children, className, firstRun = false }: { children: ReactNode; className?: string; firstRun?: boolean }) {
  return (
    <main className="suite-app">
      <section className={firstRun ? 'mos-shell suite-auth-layout suite-first-run' : 'mos-shell suite-auth-layout'}>
        <div className={className ? `suite-auth-stage ${className}` : 'suite-auth-stage'}>
          <div className="suite-auth-brand">
            <img
              alt=""
              className="suite-auth-mark"
              height="56"
              src="/suite-manager/assets/brand/my-own-suite-mark.png"
              width="56"
            />
            <span className="mos-eyebrow">My Own Suite</span>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
