import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';

import { cn } from '@/lib/utils';

// MOS design-system field: box treatment from .mos-row-input in the synced
// mos.css, with the planner's compact editor density (.input in globals.css).
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      className={cn('mos-row-input input', className)}
      {...props}
    />
  );
}

export { Input };
