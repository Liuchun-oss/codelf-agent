import { Icon, addCollection } from '@iconify/react'
import vscodeIcons from '@iconify-json/vscode-icons/icons.json'
import { getFileIconName, getFolderIconName } from '@/utils/icon'


addCollection(vscodeIcons as unknown as Parameters<typeof addCollection>[0])

interface FileIconProps {
  name: string
  isDir?: boolean
  expanded?: boolean
  size?: number
}


export default function FileIcon({
  name,
  isDir = false,
  expanded = false,
  size = 16
}: FileIconProps): JSX.Element {
  const id = isDir ? getFolderIconName(name, expanded) : getFileIconName(name)
  return (
    <Icon
      icon={`vscode-icons:${id}`}
      className="file-icon"
      width={size}
      height={size}
      aria-hidden
    />
  )
}
