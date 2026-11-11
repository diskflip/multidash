import { forwardRef, type ReactNode } from 'react';
import { motion, useIsPresent, useReducedMotion } from 'motion/react';

type Props = {
  symbol: string;
  className: string;
  horizontal: boolean;
  layoutKey: string;
  onClick: () => void;
  children: ReactNode;
};

// Keep the real card alive through exit; never clone controls or SVG IDs.
export const AnimatedMarketCard = forwardRef<HTMLDivElement, Props>(function AnimatedMarketCard(
  { symbol, className, horizontal, layoutKey, onClick, children }, ref,
) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return <motion.div
    ref={ref}
    layout={reduced ? false : 'position'}
    layoutDependency={layoutKey}
    className={`${className}${present ? '' : ' market-exit-ghost'}`}
    data-symbol={present ? symbol : undefined}
    aria-hidden={!present || undefined}
    inert={!present}
    onClick={onClick}
    initial={reduced ? false : { opacity: 0, x: horizontal ? 18 : 0, y: horizontal ? 0 : 14 }}
    animate={{ opacity: 1, x: 0, y: 0 }}
    exit={{ opacity: 0, y: reduced ? 0 : 10, transition: { duration: reduced ? 0 : .18, ease: 'easeOut' } }}
    transition={{
      layout: reduced ? { duration: 0 } : { type: 'spring', stiffness: 210, damping: 31, mass: 1 },
      opacity: { duration: reduced ? 0 : .22 },
      x: { duration: reduced ? 0 : .36, ease: [.22, 1, .36, 1] },
      y: { duration: reduced ? 0 : .36, ease: [.22, 1, .36, 1] },
    }}
  >{children}</motion.div>;
});
