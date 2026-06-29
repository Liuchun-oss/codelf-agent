import ReactDOM from 'react-dom/client'
import './overlay.css'

// 接管视觉指示：整屏径向渐变蒙层，四周半透明高亮、向屏幕中心淡出（中心完全透明不挡视线），
// 边缘有缓慢的呼吸动效。全程点击穿透（body pointer-events:none）。
function Marquee(): React.JSX.Element {
  return (
    <div className="marquee">
      <div className="marquee-vignette" />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('marquee-root') as HTMLElement).render(<Marquee />)
