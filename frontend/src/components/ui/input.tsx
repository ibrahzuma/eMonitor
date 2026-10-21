import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";
import { cn } from "@/utils/cn";

const fieldBase =
  "w-full rounded-md border border-input bg-card px-2.5 text-sm shadow-xs placeholder:text-muted-foreground " +
  "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed " +
  "disabled:opacity-60 aria-[invalid=true]:border-destructive";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type ?? "text"} className={cn(fieldBase, "h-8", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldBase, "min-h-[72px] py-1.5", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

/** Styled native <select>: fully accessible and keyboard friendly. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(fieldBase, "h-8 pr-7", className)} {...props}>
      {children}
    </select>
  ),
);
NativeSelect.displayName = "NativeSelect";

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn("text-xs font-medium text-foreground/90", className)} {...props} />
));
Label.displayName = "Label";

interface FieldProps {
  label: React.ReactNode;
  htmlFor: string;
  error?: string | null;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/** Form field wrapper: label, control, hint and error message wired with aria attributes. */
export function Field({ label, htmlFor, error, hint, required, className, children }: FieldProps) {
  const hintId = hint && !error ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const child = React.isValidElement<Record<string, unknown>>(children)
    ? React.cloneElement(children, {
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })
    : children;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-destructive" aria-hidden>*</span>}
      </Label>
      {child}
      {hint && !error && <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
