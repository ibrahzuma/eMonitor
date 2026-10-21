import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/utils/cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary ring-primary/25",
        secondary: "bg-secondary text-secondary-foreground ring-border",
        outline: "bg-transparent text-muted-foreground ring-border",
        destructive: "bg-destructive/10 text-destructive ring-destructive/25",
        success: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-300",
        warning: "bg-amber-500/10 text-amber-700 ring-amber-600/20 dark:text-amber-300",
        info: "bg-sky-500/10 text-sky-700 ring-sky-600/20 dark:text-sky-300",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
