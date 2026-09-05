import * as React from 'react';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// Base UI provides the behavior (portal, focus trap, ARIA); the surface is the
// MOS overlay language — frost backdrop plus an elevated panel — with only
// dialog layout owned by the planner stylesheet.
function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root {...props} />;
}

function AlertDialogContent({
  className,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="mos-frost-backdrop dialog-backdrop" />
      <AlertDialogPrimitive.Popup
        className={cn('mos-panel mos-panel-strong dialog-pop', className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return <div className={cn('dialog-header', className)} {...props} />;
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return <div className={cn('dialog-footer', className)} {...props} />;
}

function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('mos-card-title', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      className={cn('dialog-desc', className)}
      {...props}
    />
  );
}

function AlertDialogAction({ ...props }: React.ComponentProps<typeof Button>) {
  return <Button {...props} />;
}

function AlertDialogCancel({
  variant = 'outline',
  size = 'default',
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <AlertDialogPrimitive.Close
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
};
