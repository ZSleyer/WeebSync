import { CalendarEntry } from '@weebsync/design-system'

export const Upcoming = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
    <CalendarEntry title="One Piece" episode="Folge 1157 (1157)" time="09:30" countdown="in 2 Std 14 Min" />
    <CalendarEntry title="Detektiv Conan" episode="Folge 1158" time="18:00" countdown="in 10 Std" />
  </div>
)

export const Today = () => (
  <div style={{ maxWidth: 480 }}>
    <CalendarEntry title="Dr. Stone" episode="Folge 51" time="17:30:00" countdown="in 3 Min" />
  </div>
)
