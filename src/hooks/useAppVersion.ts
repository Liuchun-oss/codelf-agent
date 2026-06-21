import { useEffect, useState } from 'react'

/** 运行时动态获取应用版本号（来自 Electron app.getVersion，即打包 package.json 的 version）。 */
export function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.lc.getAppVersion().then(setVersion)
  }, [])
  return version
}
