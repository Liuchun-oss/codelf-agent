import PopoverMenu, { type PopoverMenuItem } from '@/components/common/PopoverMenu'

export type MenuItem = PopoverMenuItem

interface ContextMenuProps {
  x: number
  y: number
  items: PopoverMenuItem[]
  onClose: () => void
}

export default function ContextMenu(props: ContextMenuProps): JSX.Element {
  return <PopoverMenu {...props} />
}
