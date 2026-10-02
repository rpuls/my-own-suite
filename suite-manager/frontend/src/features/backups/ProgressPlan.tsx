import { useEffect, useRef, useState } from 'react';

import { Icon, PanelItem, PanelList } from '../../components/ui';
import type { JobProgress } from './model';

// What a running job consists of, said as the few things an owner would name
// rather than every stage at once. The group that is running is open, so the
// only detail on the screen is the detail of where the job actually is; a
// group that finishes folds away behind its own line.
//
// A group can also be opened by hand, and stays open until that group changes
// state — a poll every few seconds must not close what someone is reading,
// and must not hold open what the job has left behind.
export function ProgressPlan({ plan }: { plan: JobProgress['plan'] }) {
  const states = plan.map((group) => group.state).join('|');
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const previous = useRef<string[]>([]);

  useEffect(() => {
    const current = states.split('|');
    const moved = current.map((state, index) => (previous.current[index] === state ? -1 : index)).filter((index) => index >= 0);
    previous.current = current;
    if (moved.length) setOpened((manual) => {
      const next = { ...manual };
      for (const index of moved) delete next[index];
      return next;
    });
  }, [states]);

  return <PanelList>
    {plan.map((group, index) => {
      const steps = group.steps || [];
      const open = steps.length > 0 && (opened[index] ?? group.state === 'now');
      const dot = <span className={`suite-bk-dot is-${group.state === 'next' ? 'muted' : 'ready'}`} />;
      return <PanelItem className={`suite-bk-step is-${group.state}`} flush key={group.sentence} quiet={group.state === 'next'}>
        {steps.length ? <button
          aria-expanded={open}
          className="suite-bk-group"
          onClick={() => setOpened((manual) => ({ ...manual, [index]: !open }))}
          type="button"
        >
          {dot}
          <span>{group.sentence}</span>
          <span className={`suite-bk-group-mark${open ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
        </button> : <p className="suite-bk-group is-plain">{dot}<span>{group.sentence}</span></p>}

        {open ? <ul className="suite-bk-substeps">
          {steps.map((line) => <li className={`is-${line.state}`} key={line.sentence}>
            <span className={`suite-bk-dot is-${line.state === 'next' ? 'muted' : 'ready'}`} />
            <span>{line.sentence}</span>
          </li>)}
        </ul> : null}
      </PanelItem>;
    })}
  </PanelList>;
}
