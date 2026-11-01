import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";

export function DraftHeroProjectHeading({
  children,
  projectName,
}: {
  children: ReactNode;
  projectName: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLSpanElement>(null);
  const [fitsInline, setFitsInline] = useState(false);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- measures the heading against its container via ResizeObserver to choose inline or stacked layout
  useLayoutEffect(() => {
    const container = containerRef.current;
    const inline = inlineRef.current;
    if (!container || !inline) return;

    // Measure the full inline heading independently of its current layout, so
    // moving the name below it cannot make the fit check oscillate.
    const update = () =>
      setFitsInline(
        inline.getBoundingClientRect().width <= container.getBoundingClientRect().width,
      );
    update();
    return observeResize([container, inline], update);
  }, []);

  return (
    <div ref={containerRef} className="group/draft-hero relative w-full" data-inline={fitsInline}>
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <span
          ref={inlineRef}
          className="flex w-max items-baseline gap-2 whitespace-nowrap font-normal text-[2rem] tracking-[-0.03em]"
        >
          <span>What should we build in</span>
          <span>
            <span>{projectName}</span>?
          </span>
        </span>
      </span>
      <h1 className="flex w-full flex-col items-start justify-start gap-x-2 gap-y-1 text-left font-normal text-2xl text-foreground tracking-[-0.03em] sm:text-[2rem] sm:leading-tight lg:group-data-[inline=true]/draft-hero:flex-row">
        <span className="max-w-full lg:group-data-[inline=true]/draft-hero:shrink-0">
          What should we build
          <span className="lg:group-data-[inline=true]/draft-hero:hidden">?</span>
          <span className="hidden lg:group-data-[inline=true]/draft-hero:inline"> in</span>
        </span>
        <span className="flex min-w-0 max-w-full items-baseline justify-start text-base tracking-normal lg:group-data-[inline=true]/draft-hero:text-[2rem] lg:group-data-[inline=true]/draft-hero:tracking-[-0.03em]">
          <span className="min-w-0">{children}</span>
          <span className="hidden shrink-0 lg:group-data-[inline=true]/draft-hero:inline">?</span>
        </span>
      </h1>
    </div>
  );
}
