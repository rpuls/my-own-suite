import * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea className={cn('mos-row-input input', className)} {...props} />
  );
}

export { Textarea };
