import type { SVGProps } from "react";

/**
 * The LogicPacks mark: a pack (rounded square) holding one unit of logic (the dot). Drawn in
 * currentColor on the 32-unit grid of assets/brand/logicpacks-mark.svg, so it follows the
 * surrounding text colour wherever the app names itself (tool rows, lifecycle rows).
 */
export function LogicPacksMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="6.5" y="6.5" width="19" height="19" rx="5" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="3.5" fill="currentColor" />
    </svg>
  );
}

/** The app tile (ink square, paper mark), for places that show the app icon itself. */
export function LogicPacksAppIcon(props: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={props.className}>
      <rect width="32" height="32" rx="7" fill="#181818" />
      <rect
        x="6.5"
        y="6.5"
        width="19"
        height="19"
        rx="5"
        fill="none"
        stroke="#ececea"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="3.5" fill="#ececea" />
    </svg>
  );
}
