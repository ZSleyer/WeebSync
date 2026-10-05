import type { HTMLAttributes, ReactNode } from 'react'
import { useLongPress } from '@weebsync/design-system'

/**
 * A list item or wrapper that opens its item's menu on a long press with a
 * finger (useLongPress) - a component, so a list can give every row its own
 * without calling the hook in a loop.
 */
export default function Press({
  as: Tag = 'div',
  onLongPress,
  children,
  ...rest
}: { as?: 'div' | 'li'; onLongPress?: () => void; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag {...rest} {...useLongPress(onLongPress)}>
      {children}
    </Tag>
  )
}
