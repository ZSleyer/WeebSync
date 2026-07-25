import { Cover } from '@weebsync/design-system'

// Data-URI posters in deliberately mismatched aspect ratios: the frame is fixed
// and object-cover crops, so none of them may change the layout.
const poster = (w: number, h: number, label: string, hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="${w}" height="${h}" fill="hsl(${hue} 45% 32%)"/>` +
      `<text x="50%" y="50%" fill="white" font-family="sans-serif" font-size="${Math.round(Math.min(w, h) / 6)}" text-anchor="middle" dominant-baseline="middle">${label}</text>` +
      `</svg>`,
  )}`

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
    <Cover />
    <Cover size="sm" />
  </div>
)

/** Four posters, four aspect ratios - every frame stays identical. */
export const AnyImageRatio = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
    <Cover src={poster(460, 650, '2:3', 265)} />
    <Cover src={poster(1200, 300, 'breit', 190)} />
    <Cover src={poster(300, 1200, 'hoch', 340)} />
    <Cover src={poster(64, 64, 'winzig', 90)} />
  </div>
)

export const SmallWithImages = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
    <Cover size="sm" src={poster(460, 650, '2:3', 265)} />
    <Cover size="sm" src={poster(1200, 300, 'breit', 190)} />
    <Cover size="sm" />
  </div>
)
