import { CalendarDay, CalendarEntry } from '@weebsync/design-system'

export const Day = () => (
  <div style={{ maxWidth: 480 }}>
    <CalendarDay day="Sonntag, 27.07.">
      <CalendarEntry title="One Piece" episode="Folge 1157" time="09:30" countdown="in 2 Std" />
      <CalendarEntry title="Clevatess" episode="Folge 5" time="17:00" countdown="in 9 Std" />
    </CalendarDay>
  </div>
)

export const EmptyDay = () => (
  <div style={{ maxWidth: 480 }}>
    <CalendarDay day="Montag, 28.07.">
      <CalendarEntry title="Witch Hat Atelier" episode="Folge 4" time="21:45" countdown="morgen" />
    </CalendarDay>
  </div>
)
