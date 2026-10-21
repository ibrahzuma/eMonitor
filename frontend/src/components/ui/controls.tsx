import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { Check, Minus } from "lucide-react";
import * as React from "react";
import { cn } from "@/utils/cn";

// ---------------------------------------------------------------- checkbox

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-input bg-card " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 " +
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground " +
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      {props.checked === "indeterminate" ? <Minus className="size-3" /> : <Check className="size-3" />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";

/** Checkbox with an inline label. */
export function CheckboxField({ id, label, checked, onCheckedChange, disabled, hint }: {
  id: string;
  label: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5" />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm leading-5">{label}</label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- switch

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 " +
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export function SwitchField({ id, label, checked, onCheckedChange, disabled, hint }: {
  id: string;
  label: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm leading-5">{label}</label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

// ---------------------------------------------------------------- tabs

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("scrollbar-thin flex items-center gap-1 overflow-x-auto border-b", className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground " +
        "hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:border-primary " +
        "data-[state=active]:font-medium data-[state=active]:text-foreground [&_svg]:size-4",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("pt-4 focus-visible:outline-none", className)} {...props} />
));
TabsContent.displayName = "TabsContent";

// ---------------------------------------------------------------- separator

export function Separator({ className, orientation = "horizontal" }: {
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
    />
  );
}

// ---------------------------------------------------------------- segmented control (range pickers etc.)

export function Segmented<T extends string>({ value, options, onChange, label, size = "sm" }: {
  value: T;
  options: readonly (T | { value: T; label: string })[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "xs";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border bg-card p-0.5">
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v)}
            className={cn(
              "rounded px-2 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
              size === "sm" ? "h-6 text-xs" : "h-5 text-[11px]",
              active && "bg-secondary text-foreground shadow-xs",
            )}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- progress bar

export function ProgressBar({ value, max = 100, color, label, className }: {
  value: number | null | undefined;
  max?: number;
  color?: string;
  label?: string;
  className?: string;
}) {
  const pct = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color ?? "var(--primary)" }} />
    </div>
  );
}
