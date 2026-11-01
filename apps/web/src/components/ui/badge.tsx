import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

// LogicPacks chips: pill-shaped, hairline-outlined, sentence case. State reads from a leading
// dot (brand.css, data-lp-dot) and a tinted label, not a tinted fill. See apps/web/DESIGN.md.
const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-transparent font-medium tracking-[-0.003em] outline-none transition-[color,background-color,border-color] duration-(--lp-dur-1) ease-lp focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        control: "h-7 min-w-7 px-2.5 text-sm sm:h-6 sm:min-w-6 sm:text-xs",
        default: "h-5.5 min-w-5.5 px-2 text-sm sm:h-5 sm:min-w-5 sm:text-[11px]",
        lg: "h-6.5 min-w-6.5 px-2.5 text-base sm:h-6 sm:min-w-6 sm:text-xs",
        // Fractional leading rounds font metrics and raises fixed-height labels, especially under zoom.
        sm: "h-5 min-w-5 gap-1 px-1.5 text-xs leading-none sm:h-[1.125rem] sm:min-w-[1.125rem] sm:text-[10.5px]",
      },
      variant: {
        default: "bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/88",
        destructive: "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
        error:
          "border-destructive/30 text-destructive-foreground [button&,a&]:hover:bg-destructive/8",
        info: "border-hairline text-info-foreground [button&,a&]:hover:bg-accent",
        outline:
          "border-hairline text-muted-foreground [button&,a&]:hover:border-hairline-strong [button&,a&]:hover:text-foreground",
        secondary: "bg-well text-secondary-foreground [button&,a&]:hover:bg-well-strong",
        success: "border-success/30 text-success-foreground [button&,a&]:hover:bg-success/8",
        warning: "border-warning/35 text-warning-foreground [button&,a&]:hover:bg-warning/8",
        label:
          "border-[color-mix(in_srgb,var(--label)_30%,transparent)] text-[color-mix(in_srgb,var(--label)_45%,var(--color-foreground))]",
      },
    },
  },
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };
