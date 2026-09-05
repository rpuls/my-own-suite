import { Button as ButtonPrimitive } from '@base-ui/react/button';

import { cn } from '@/lib/utils';

// MOS design-system button: colors, gradient, radius, and focus treatment come
// from the shared .mos-btn classes in the synced mos.css; the planner adds
// only the compact editor density (.btn* in globals.css).
type Variant = 'default' | 'outline' | 'ghost' | 'destructive';
type Size = 'default' | 'sm' | 'icon' | 'icon-sm';

const VARIANT_CLASSES: Record<Variant, string> = {
  default: 'mos-btn mos-btn-primary btn',
  outline: 'mos-btn mos-btn-secondary btn',
  ghost: 'mos-btn mos-btn-ghost btn',
  destructive: 'mos-btn btn btn-danger',
};

const SIZE_CLASSES: Record<Size, string> = {
  default: '',
  sm: 'btn-sm',
  icon: 'btn-icon',
  'icon-sm': 'btn-icon btn-icon-sm',
};

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & { variant?: Variant; size?: Size }) {
  return (
    <ButtonPrimitive
      className={cn(VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      {...props}
    />
  );
}

export { Button };
